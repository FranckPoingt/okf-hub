import { Crepe } from "@milkdown/crepe";
import { editorViewOptionsCtx } from "@milkdown/kit/core";
import { getMarkdown, replaceAll } from "@milkdown/kit/utils";
import { collab, collabServiceCtx } from "@milkdown/plugin-collab";
import {
  Milkdown,
  MilkdownProvider,
  useEditor,
  useInstance,
} from "@milkdown/react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import * as Y from "yjs";
import {
  type Collaborator,
  type ConnectionStatus,
  DenoCollabProvider,
} from "./collab-provider.ts";

const SERVICE = globalThis.location.port === "8788"
  ? globalThis.location.origin
  : "http://127.0.0.1:8788";
const CONCEPT_PATH = "/api/concepts/incident-communication";
const PROFILE_MARKERS = [
  "- [x]",
  "| Severity",
  "~~",
  "[^owner]",
  "```mermaid",
  "$$",
];

type Invitation = {
  invitationId: string;
  email: string;
  access: string;
  url: string;
  status: string;
};
type Bootstrap = {
  user: { id: string; name: string; email: string } | null;
  access?: "owner" | "editor" | "viewer" | "none";
  canView?: boolean;
  canEdit?: boolean;
  setupRequired?: boolean;
  invitationRequired?: boolean;
  invitations?: Invitation[];
};
type AuditEvent = { occurredAt: string; action: string; target: string };

function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${SERVICE}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
}

function AuthScreen(
  { onAuthenticated }: { onAuthenticated: () => Promise<void> },
) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-up");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const invited = new URLSearchParams(globalThis.location.search).has(
    "invitation",
  );

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form);
    if (mode === "sign-in") delete body.name;
    const response = await api(`/api/auth/${mode}/email`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      setError(result.message ?? result.error ?? "Authentication failed");
      setBusy(false);
      return;
    }
    await onAuthenticated();
  };

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <a className="brand" href="/" aria-label="OKF Hub home">
          <span>O</span> OKF Hub
        </a>
        <p className="eyebrow">
          {invited ? "You have been invited" : "Customer-controlled knowledge"}
        </p>
        <h1>{mode === "sign-up" ? "Create your account" : "Welcome back"}</h1>
        <p>
          {invited
            ? "Use the invited email address, then accept your access."
            : "Sign in to your organisation’s private knowledge hub."}
        </p>
        <form onSubmit={(event) => void submit(event)}>
          {mode === "sign-up" && (
            <label>
              Name<input name="name" autoComplete="name" required />
            </label>
          )}
          <label>
            Email<input
              name="email"
              type="email"
              autoComplete="email"
              required
            />
          </label>
          <label>
            Password<input
              name="password"
              type="password"
              minLength={8}
              autoComplete={mode === "sign-up"
                ? "new-password"
                : "current-password"}
              required
            />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary" type="submit" disabled={busy}>
            {busy
              ? "Working…"
              : mode === "sign-up"
              ? "Create account"
              : "Sign in"}
          </button>
        </form>
        <button
          className="text-button"
          type="button"
          onClick={() => setMode(mode === "sign-up" ? "sign-in" : "sign-up")}
        >
          {mode === "sign-up"
            ? "Already have an account? Sign in"
            : "Need an account? Sign up"}
        </button>
      </section>
    </main>
  );
}

function AccessGate(
  { invited, onAccepted, onSignOut }: {
    invited: boolean;
    onAccepted: () => Promise<void>;
    onSignOut: () => void;
  },
) {
  const [error, setError] = useState("");
  const accept = async () => {
    const invitationId = new URLSearchParams(globalThis.location.search).get(
      "invitation",
    );
    const response = await api("/api/invitations/accept", {
      method: "POST",
      body: JSON.stringify({ invitationId }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      setError(result.error ?? "Could not accept invitation");
      return;
    }
    globalThis.history.replaceState({}, "", globalThis.location.pathname);
    await onAccepted();
  };
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <a className="brand" href="/" aria-label="OKF Hub home">
          <span>O</span> OKF Hub
        </a>
        <p className="eyebrow">Organisation access</p>
        <h1>{invited ? "Accept your invitation" : "Access not granted"}</h1>
        <p>
          {invited
            ? "This invitation adds you to the group that controls the Policies space."
            : "Ask the organisation owner for an editor or viewer invitation."}
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
        {invited && (
          <button
            className="primary"
            type="button"
            onClick={() => void accept()}
          >
            Accept invitation
          </button>
        )}
        <button className="text-button" type="button" onClick={onSignOut}>
          Sign out
        </button>
      </section>
    </main>
  );
}

function AccessPanel({ invitations }: { invitations: Invitation[] }) {
  const [email, setEmail] = useState("");
  const [access, setAccess] = useState<"editor" | "viewer">("editor");
  const [items, setItems] = useState(invitations);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [error, setError] = useState("");

  const loadAudit = () =>
    api("/api/audit").then((response) => response.json()).then(setAudit);
  useEffect(() => {
    void loadAudit();
  }, []);

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const response = await api("/api/invitations", {
      method: "POST",
      body: JSON.stringify({ email, access }),
    });
    const result = await response.json();
    if (!response.ok) return setError(result.error ?? "Invitation failed");
    setItems([{
      invitationId: result.id,
      email,
      access,
      url: result.url,
      status: "pending",
    }, ...items]);
    setEmail("");
    void loadAudit();
  };

  return (
    <section className="access-panel" aria-labelledby="access-heading">
      <div>
        <p className="eyebrow">Permissions</p>
        <h2 id="access-heading">Invite through a group</h2>
      </div>
      <form onSubmit={(event) => void invite(event)}>
        <label>
          Email<input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label>
          Access<select
            value={access}
            onChange={(event) =>
              setAccess(event.target.value as "editor" | "viewer")}
          >
            <option value="editor">Policy editor</option>
            <option value="viewer">Policy viewer</option>
          </select>
        </label>
        <button className="primary" type="submit">Create invite link</button>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="invite-list">
        {items.map((item) => (
          <div key={item.invitationId}>
            <strong>{item.email}</strong>
            <span>{item.access} · {item.status}</span>
            <input
              aria-label={`Invitation link for ${item.email}`}
              readOnly
              value={item.url}
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        ))}
      </div>
      <div className="audit-list">
        <h3>Permission audit</h3>
        {audit.map((event) => (
          <p key={`${event.occurredAt}-${event.target}`}>
            <time>{new Date(event.occurredAt).toLocaleString()}</time>
            <strong>{event.action}</strong>
            <span>{event.target}</span>
          </p>
        ))}
      </div>
    </section>
  );
}

function EditorControls(
  { markdown, canEdit }: { markdown: string; canEdit: boolean },
) {
  const [loading, getEditor] = useInstance();
  const input = useRef<HTMLInputElement>(null);
  const importMarkdown = async (file?: File) => {
    if (!file || loading || !canEdit) return;
    getEditor()?.action(replaceAll(await file.text()));
    if (input.current) input.current.value = "";
  };
  const exportMarkdown = () => {
    const content = getEditor()?.action(getMarkdown()) ?? markdown;
    const url = URL.createObjectURL(
      new Blob([content], { type: "text/markdown" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "incident-communication.md";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="editor-actions">
      <input
        ref={input}
        type="file"
        accept=".md,text/markdown,text/plain"
        onChange={(event) => void importMarkdown(event.target.files?.[0])}
        hidden
      />
      {canEdit && (
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={loading}
        >
          Import .md
        </button>
      )}
      <button
        type="button"
        className="primary"
        onClick={exportMarkdown}
        disabled={loading}
      >
        Export .md
      </button>
    </div>
  );
}

function EditorSurface(
  { initialMarkdown, user, canEdit, onMarkdown, onStatus, onCollaborators }: {
    initialMarkdown: string;
    user: Collaborator;
    canEdit: boolean;
    onMarkdown: (markdown: string) => void;
    onStatus: (status: ConnectionStatus) => void;
    onCollaborators: (users: Collaborator[]) => void;
  },
) {
  const providerRef = useRef<DenoCollabProvider | undefined>(undefined);
  useEffect(() => () => providerRef.current?.destroy(), []);
  useEditor((root) => {
    const doc = new Y.Doc();
    const provider = new DenoCollabProvider(
      `${SERVICE.replace("http", "ws")}/collab`,
      doc,
      user,
      onStatus,
      onCollaborators,
    );
    providerRef.current?.destroy();
    providerRef.current = provider;
    let editorConnected = false;
    const crepe = new Crepe({
      root,
      features: {
        [Crepe.Feature.AI]: false,
        [Crepe.Feature.ImageBlock]: false,
        [Crepe.Feature.TopBar]: false,
      },
    });
    crepe.editor.use(collab).config((ctx) =>
      ctx.update(
        editorViewOptionsCtx,
        (options) => ({ ...options, editable: () => canEdit }),
      )
    );
    crepe.on((listener) => {
      listener.mounted((ctx) => {
        const service = ctx.get(collabServiceCtx).bindDoc(doc).setAwareness(
          provider.awareness,
        );
        provider.onSynced(() => {
          if (editorConnected) return;
          service.applyTemplate(initialMarkdown).connect();
          editorConnected = true;
          globalThis.requestAnimationFrame(() =>
            onMarkdown(crepe.getMarkdown())
          );
        });
        provider.connect();
      });
      listener.markdownUpdated((_ctx, markdown, previous) => {
        if (canEdit && markdown !== previous) onMarkdown(markdown);
      });
    });
    return crepe;
  }, [initialMarkdown, user.name, canEdit]);
  return <Milkdown />;
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [fatal, setFatal] = useState("");
  const [initialMarkdown, setInitialMarkdown] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "failed">(
    "saved",
  );
  const [accessOpen, setAccessOpen] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const refresh = useCallback(async () => {
    let response = await api("/api/bootstrap");
    let result = await response.json() as Bootstrap & { error?: string };
    if (result.setupRequired) {
      response = await api("/api/setup", { method: "POST" });
      result = await response.json();
    }
    if (!response.ok) throw new Error(result.error ?? "Service unavailable");
    setBootstrap(result);
  }, []);

  useEffect(() => {
    refresh().catch((error) => setFatal(error.message));
  }, [refresh]);
  useEffect(() => {
    if (!bootstrap?.canView) return;
    api(CONCEPT_PATH).then((response) => {
      if (!response.ok) throw new Error("Concept unavailable");
      return response.text();
    }).then((content) => {
      setInitialMarkdown(content);
      setMarkdown(content);
    }).catch((error) => setFatal(error.message));
  }, [bootstrap?.canView]);

  const signOut = () => {
    void api("/api/auth/sign-out", { method: "POST" }).finally(() => {
      setBootstrap({ user: null });
      setInitialMarkdown(null);
    });
  };
  const saveMarkdown = useCallback((content: string) => {
    if (!bootstrap?.canEdit) return;
    setMarkdown(content);
    setSaveState("saving");
    if (saveTimer.current) globalThis.clearTimeout(saveTimer.current);
    saveTimer.current = globalThis.setTimeout(() => {
      api(CONCEPT_PATH, { method: "PUT", body: content }).then((response) => {
        if (!response.ok) throw new Error("save failed");
        setSaveState("saved");
      }).catch(() => setSaveState("failed"));
    }, 300);
  }, [bootstrap?.canEdit]);

  if (fatal) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">Service error</p>
          <h1>Could not open OKF Hub</h1>
          <p>{fatal}</p>
          <button
            className="primary"
            type="button"
            onClick={() => globalThis.location.reload()}
          >
            Retry
          </button>
        </section>
      </main>
    );
  }
  if (!bootstrap) {
    return (
      <main className="auth-shell">
        <div className="editor-loading">Opening OKF Hub…</div>
      </main>
    );
  }
  if (!bootstrap.user) return <AuthScreen onAuthenticated={refresh} />;
  const invitationId = new URLSearchParams(globalThis.location.search).get(
    "invitation",
  );
  if (!bootstrap.canView) {
    return (
      <AccessGate
        invited={Boolean(invitationId && bootstrap.invitationRequired)}
        onAccepted={refresh}
        onSignOut={signOut}
      />
    );
  }

  const user: Collaborator = {
    name: bootstrap.user.name,
    color: bootstrap.access === "owner"
      ? "#e76f51"
      : bootstrap.access === "editor"
      ? "#52796f"
      : "#d5a64f",
  };
  const profileCoverage =
    PROFILE_MARKERS.filter((marker) => markdown.includes(marker)).length;
  return (
    <main className="app-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="OKF Hub home">
          <span>O</span> OKF Hub
        </a>
        <div className="document-title">
          <small>Policies /</small>
          <strong>Incident communication</strong>
        </div>
        <div className="header-status">
          <span className={`connection ${status}`}>
            <i />
            {status}
          </span>
          <span className="save-state">
            {bootstrap.canEdit
              ? saveState === "saved" ? "Saved as Markdown" : saveState
              : "View only"}
          </span>
        </div>
      </header>
      <aside className="sidebar">
        <p className="section-label">Company knowledge</p>
        <nav>
          <button type="button">
            ⌕ <span>Search</span>
          </button>
          <button type="button">
            ⌂ <span>Home</span>
          </button>
        </nav>
        <p className="section-label spaces-label">Spaces</p>
        <nav>
          <button type="button" className="active">
            <i className="space-dot coral" /> <span>Policies</span>
            <b>1</b>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <p className="section-label">Signed in</p>
          <div className="account">
            <strong>{bootstrap.user.name}</strong>
            <span>{bootstrap.access}</span>
          </div>
          {bootstrap.access === "owner" && (
            <button
              type="button"
              onClick={() => setAccessOpen(!accessOpen)}
            >
              Manage access
            </button>
          )}
          <button type="button" onClick={signOut}>Sign out</button>
          <div className="coverage">
            <strong>{profileCoverage}/{PROFILE_MARKERS.length}</strong>
            <span>extended profile markers intact</span>
          </div>
        </div>
      </aside>
      <section className="workspace">
        {accessOpen && bootstrap.access === "owner" && (
          <AccessPanel invitations={bootstrap.invitations ?? []} />
        )}
        <MilkdownProvider>
          <div className="workspace-bar">
            <div
              className="people"
              aria-label={`${collaborators.length} collaborators online`}
            >
              {collaborators.map((person) => (
                <span
                  key={person.name}
                  style={{ background: person.color }}
                  title={person.name}
                >
                  {person.name.split(" ").map((part) => part[0]).join("")}
                </span>
              ))}
              <small>{collaborators.length} online</small>
            </div>
            <span className="access-badge">{bootstrap.access}</span>
            <EditorControls
              markdown={markdown}
              canEdit={Boolean(bootstrap.canEdit)}
            />
          </div>
          <div
            className={`editor-frame ${bootstrap.canEdit ? "" : "read-only"}`}
          >
            {initialMarkdown
              ? (
                <>
                  <div className="editor-context">
                    <span className="draft-label">
                      POLICY ·{" "}
                      {bootstrap.canEdit ? "SHARED DRAFT" : "VIEW ONLY"}
                    </span>
                    <span>
                      {bootstrap.canEdit ? "Editing" : "Viewing"} as{" "}
                      <strong>{user.name}</strong>
                    </span>
                  </div>
                  <EditorSurface
                    initialMarkdown={initialMarkdown}
                    user={user}
                    canEdit={Boolean(bootstrap.canEdit)}
                    onMarkdown={saveMarkdown}
                    onStatus={setStatus}
                    onCollaborators={setCollaborators}
                  />
                </>
              )
              : (
                <div className="editor-loading">
                  Opening authorised concept…
                </div>
              )}
          </div>
        </MilkdownProvider>
      </section>
    </main>
  );
}

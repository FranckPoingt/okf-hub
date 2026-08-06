import { Crepe } from "@milkdown/crepe";
import { editorViewOptionsCtx } from "@milkdown/kit/core";
import { collab, collabServiceCtx } from "@milkdown/plugin-collab";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
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
import { type AppRoute, parseAppRoute, routePath } from "./routes.ts";

const SERVICE = globalThis.location.port === "8788"
  ? globalThis.location.origin
  : "http://127.0.0.1:8788";
const conceptPath = (id: string) => `/api/concepts/${encodeURIComponent(id)}`;
const setBrowserRoute = (
  route: Exclude<AppRoute, { kind: "not_found" }>,
  replace = false,
) => {
  const path = routePath(route);
  if (globalThis.location.pathname === path && !globalThis.location.search) {
    return;
  }
  globalThis.history[replace ? "replaceState" : "pushState"]({}, "", path);
};
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
type Revision = {
  number: number;
  publishedAt: string;
  actorUserId: string;
};
type DocumentIntent = "canonical" | "working" | "evidence" | "ephemeral";
type WorkTrace = {
  id: string;
  conceptId: string;
  conceptTitle: string;
  kind: "change" | "decision" | "incident" | "outcome";
  title: string;
  summary: string;
  occurredAt: string;
  sourceUrl: string;
  actorUserId: string;
  createdAt: string;
  foldedIntoConceptId: string | null;
  foldedIntoTitle: string | null;
  foldedAt: string | null;
  foldedKnowledge: string | null;
};
type Concept = {
  id: string;
  spaceId: string;
  space: string;
  title: string;
  type: string;
  intent: DocumentIntent;
  status: "active" | "archived";
  publishedRevision: number | null;
  updatedAt: string;
  draft: string | null;
  published: string | null;
  revisions: Revision[];
  workTraces: WorkTrace[];
};
type Space = { id: string; name: string; count: number };
type SourceIssue = {
  path: string;
  status: "invalid" | "deleted" | "renamed";
  error: string | null;
  nextPath: string | null;
};
type RepositorySource = {
  id: string;
  repositoryUrl: string;
  folder: string;
  credentialsConfigured: boolean;
  status: "syncing" | "current" | "sync_failed";
  revision: string | null;
  lastSyncedAt: string | null;
  error: string | null;
  conceptCount: number;
  issues: SourceIssue[];
};
type SharedSource = {
  id: "shared";
  kind: "s3";
  endpoint: string;
  bucket: string;
  path: string;
  region: string;
  credentialsConfigured: true;
  status: "syncing" | "current" | "sync_failed";
  revision: string | null;
  lastSyncedAt: string | null;
  error: string | null;
  conceptCount: number;
  issues: SourceIssue[];
};
type Sources = {
  repositories: RepositorySource[];
  shared: SharedSource | null;
};
type ImportedConcept = {
  id: string;
  sourceId: string;
  path: string;
  title: string;
  type: string;
  status: "current" | "invalid";
  sourceRevision: string;
  importedAt: string;
  tags: string[];
  owner: string;
  markdown?: string;
  revisionCount?: number;
  source?: RepositorySource | SharedSource;
};
type SearchRelationship = {
  id: string;
  kind: "hub-native" | "imported";
  sourceId: string;
  title: string;
  path?: string;
  trust: "current" | "sync_failed";
  sourceLabel: string;
};
type SearchResult = SearchRelationship & {
  type: string;
  tags: string[];
  owner: string;
  status: "active" | "archived" | "current";
  sourceStatus: "current" | "sync_failed";
  sourceRevision?: string;
  importedAt?: string;
  snippet: string;
  links: SearchRelationship[];
  backlinks: SearchRelationship[];
};
type SearchResponse = {
  query: string;
  results: SearchResult[];
  facets: { types: string[]; tags: string[] };
  canIncludeArchived: boolean;
};
type AutomationProposal = {
  sourceId: string;
  path: string;
  href: string;
  target: string;
  action: "fix_broken_link";
};
type AutomationAttempt = {
  id: number;
  job: "source_check" | "broken_links";
  sourceId: string | null;
  attempt: number;
  status: "running" | "succeeded" | "failed";
  error: string | null;
  result: {
    revision?: string;
    conceptCount?: number;
    checkedConcepts?: number;
    proposals?: AutomationProposal[];
  } | null;
};
type AutomationRun = {
  id: number;
  trigger: "manual" | "scheduled";
  status: "running" | "succeeded" | "partial";
  startedAt: string;
  finishedAt: string | null;
  attempts: AutomationAttempt[];
};
type AutomationState = {
  intervalMs: number;
  running: boolean;
  runs: AutomationRun[];
};
type ArtifactVersion = {
  number: number;
  createdBy: string;
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
};
type Artifact = {
  id: string;
  conceptId: string;
  title: string;
  type: "inline_html" | "https_url";
  status: "draft" | "live" | "changes_pending";
  draftVersion?: number;
  liveVersion: number | null;
  version: number;
  content?: string;
  document?: string;
  url?: string;
  versions: ArtifactVersion[];
  updatedAt: string;
};
type ArtifactState = {
  artifacts: Artifact[];
  allowedHosts: string[];
  canEdit: boolean;
  canPublish: boolean;
};

function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
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
            ? "This invitation adds you to the group that can view or edit hub knowledge spaces."
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
            <option value="editor">Knowledge editor</option>
            <option value="viewer">Knowledge viewer</option>
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

function DocumentPreview({ markdown }: { markdown: string }) {
  useEditor((root) => {
    const crepe = new Crepe({
      root,
      defaultValue: markdown,
      features: {
        [Crepe.Feature.AI]: false,
        [Crepe.Feature.ImageBlock]: false,
        [Crepe.Feature.TopBar]: false,
      },
    });
    crepe.editor.config((ctx) =>
      ctx.update(
        editorViewOptionsCtx,
        (options) => ({ ...options, editable: () => false }),
      )
    );
    return crepe;
  }, [markdown]);
  return <Milkdown />;
}

function EditorSurface(
  {
    conceptId,
    initialMarkdown,
    user,
    canEdit,
    onMarkdown,
    onStatus,
    onCollaborators,
  }: {
    conceptId: string;
    initialMarkdown: string;
    user: Collaborator;
    canEdit: boolean;
    onMarkdown: (markdown: string) => void;
    onStatus: (status: ConnectionStatus) => void;
    onCollaborators: (users: Collaborator[]) => void;
  },
) {
  useEditor((root) => {
    const doc = new Y.Doc();
    const provider = new DenoCollabProvider(
      `${SERVICE.replace("http", "ws")}/collab?conceptId=${
        encodeURIComponent(conceptId)
      }`,
      doc,
      user,
      onStatus,
      onCollaborators,
    );
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
        });
        provider.connect();
      });
      listener.markdownUpdated((_ctx, markdown, previous) => {
        if (canEdit && markdown !== previous) onMarkdown(markdown);
      });
    });
    const destroy = crepe.destroy;
    crepe.destroy = async () => {
      provider.stop();
      try {
        return await destroy();
      } finally {
        provider.destroy();
      }
    };
    return crepe;
  }, [conceptId, initialMarkdown, user.name, canEdit]);
  return <Milkdown />;
}

function SourceIssues({ issues }: { issues: SourceIssue[] }) {
  if (!issues.length) return null;
  return (
    <section className="source-issues" aria-label="Source issues">
      <h3>Source issues</h3>
      {issues.map((issue) => (
        <p key={`${issue.status}-${issue.path}`}>
          <strong>{issue.status}</strong>
          <code>{issue.path}</code>
          <span>
            {issue.error ?? (issue.nextPath
              ? `Moved to ${issue.nextPath}`
              : "No longer present at the source revision")}
          </span>
        </p>
      ))}
    </section>
  );
}

function ImportGrid(
  { sourceId, imports, onOpen }: {
    sourceId: string;
    imports: ImportedConcept[];
    onOpen: (
      sourceId: string,
      path: string,
    ) => Promise<unknown>;
  },
) {
  return (
    <section className="import-grid" aria-label="Imported concepts">
      {imports.filter((item) => item.sourceId === sourceId).map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => void onOpen(sourceId, item.path)}
        >
          <span>{item.type}</span>
          <strong>{item.title}</strong>
          <small>{item.path}</small>
        </button>
      ))}
    </section>
  );
}

function RepositoryPanel(
  {
    source,
    imports,
    canManage,
    busy,
    error,
    onConnect,
    onRefresh,
    onDisconnect,
    onOpen,
  }: {
    source: RepositorySource | null;
    imports: ImportedConcept[];
    canManage: boolean;
    busy: boolean;
    error: string;
    onConnect: (
      source: RepositorySource | null,
      repositoryUrl: string,
      folder: string,
      username: string,
      token: string,
    ) => Promise<void>;
    onRefresh: (sourceId: string) => Promise<void>;
    onDisconnect: (source: RepositorySource) => Promise<void>;
    onOpen: (
      sourceId: string,
      path: string,
    ) => Promise<unknown>;
  },
) {
  const headingId = source
    ? `repository-heading-${source.id}`
    : "repository-heading-new";
  const connect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void onConnect(
      source,
      String(fields.get("repositoryUrl") ?? ""),
      String(fields.get("folder") ?? "okf"),
      String(fields.get("username") ?? ""),
      String(fields.get("token") ?? ""),
    );
  };
  const connectionForm = (
    <form className="source-form" onSubmit={connect}>
      <label>
        HTTPS Git URL
        <input
          name="repositoryUrl"
          type="url"
          placeholder="https://example.com/company/knowledge.git"
          defaultValue={source?.repositoryUrl}
          required
        />
      </label>
      <label>
        OKF folder
        <input name="folder" defaultValue={source?.folder ?? "okf"} required />
      </label>
      <label>
        Git username <span>(private repositories only)</span>
        <input name="username" autoComplete="username" />
      </label>
      <label>
        Access token <span>(private repositories only)</span>
        <input name="token" type="password" autoComplete="new-password" />
      </label>
      <button className="primary" type="submit" disabled={busy}>
        {busy
          ? "Connecting…"
          : source
          ? "Try different settings"
          : "Connect and import"}
      </button>
    </form>
  );
  return (
    <section className="source-card" aria-labelledby={headingId}>
      <div className="source-heading">
        <div>
          <p className="eyebrow">Git source</p>
          <h2 id={headingId}>Repository-owned OKF</h2>
          <p>
            Imported concepts stay read-only here. The Git repository remains
            authoritative.
          </p>
        </div>
        {source && canManage && (
          <button
            className="primary"
            type="button"
            disabled={busy}
            onClick={() => void onRefresh(source.id)}
          >
            {busy ? "Refreshing…" : "Refresh repository"}
          </button>
        )}
      </div>
      {!source
        ? canManage
          ? connectionForm
          : <p className="source-empty">No repository has been connected.</p>
        : (
          <>
            <dl className="source-provenance">
              <div>
                <dt>Status</dt>
                <dd className={`source-status ${source.status}`}>
                  {source.status.replace("_", " ")}
                </dd>
              </div>
              <div>
                <dt>Repository</dt>
                <dd>{source.repositoryUrl}</dd>
              </div>
              <div>
                <dt>Folder</dt>
                <dd>{source.folder}</dd>
              </div>
              <div>
                <dt>Access</dt>
                <dd>
                  {source.credentialsConfigured
                    ? "Private credentials stored"
                    : "Public HTTPS"}
                </dd>
              </div>
              <div>
                <dt>Source revision</dt>
                <dd>
                  <code>{source.revision?.slice(0, 12) ?? "None"}</code>
                </dd>
              </div>
              <div>
                <dt>Last successful sync</dt>
                <dd>
                  {source.lastSyncedAt
                    ? new Date(source.lastSyncedAt).toLocaleString()
                    : "Not yet"}
                </dd>
              </div>
            </dl>
            {source.error && (
              <p className="source-error" role="alert">{source.error}</p>
            )}
            <SourceIssues issues={source.issues} />
            {canManage && (
              <details>
                <summary>Update repository access</summary>
                {connectionForm}
                <button
                  className="disconnect-source"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (
                      globalThis.confirm(
                        `Disconnect ${source.repositoryUrl}? This removes ${source.conceptCount} imported documents from OKF Hub.`,
                      )
                    ) void onDisconnect(source);
                  }}
                >
                  Disconnect repository
                </button>
              </details>
            )}
          </>
        )}
      {error && <p className="source-error" role="alert">{error}</p>}
      {source && (
        <ImportGrid sourceId={source.id} imports={imports} onOpen={onOpen} />
      )}
    </section>
  );
}

function SharedStorePanel(
  { source, imports, canManage, busy, error, onConnect, onRefresh, onOpen }: {
    source: SharedSource | null;
    imports: ImportedConcept[];
    canManage: boolean;
    busy: boolean;
    error: string;
    onConnect: (values: Record<string, string>) => Promise<void>;
    onRefresh: () => Promise<void>;
    onOpen: (
      sourceId: string,
      path: string,
    ) => Promise<unknown>;
  },
) {
  const connect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void onConnect({
      endpoint: String(fields.get("endpoint") ?? ""),
      bucket: String(fields.get("bucket") ?? ""),
      path: String(fields.get("path") ?? "okf"),
      region: String(fields.get("region") ?? "us-east-1"),
      accessKey: String(fields.get("accessKey") ?? ""),
      secretKey: String(fields.get("secretKey") ?? ""),
    });
  };
  const connectionForm = (
    <form className="source-form shared-source-form" onSubmit={connect}>
      <label>
        S3 endpoint
        <input
          name="endpoint"
          type="url"
          placeholder="https://s3.example.com"
          defaultValue={source?.endpoint}
          required
        />
      </label>
      <label>
        Bucket
        <input name="bucket" defaultValue={source?.bucket} required />
      </label>
      <label>
        OKF path
        <input name="path" defaultValue={source?.path ?? "okf"} required />
      </label>
      <label>
        Region
        <input
          name="region"
          defaultValue={source?.region ?? "us-east-1"}
          required
        />
      </label>
      <label>
        Access key
        <input
          name="accessKey"
          autoComplete="off"
          required={!source?.credentialsConfigured}
        />
      </label>
      <label>
        Secret key
        <input
          name="secretKey"
          type="password"
          autoComplete="new-password"
          required={!source?.credentialsConfigured}
        />
      </label>
      <button className="primary" type="submit" disabled={busy}>
        {busy
          ? "Connecting…"
          : source
          ? "Retry with these settings"
          : "Connect and import"}
      </button>
    </form>
  );
  return (
    <section className="source-card" aria-labelledby="shared-heading">
      <div className="source-heading">
        <div>
          <p className="eyebrow">Shared store source</p>
          <h2 id="shared-heading">Shared controlled OKF</h2>
          <p>
            Import a portable OKF bundle directly from customer-controlled
            object storage, without GitHub.
          </p>
        </div>
        {source && canManage && (
          <button
            className="primary"
            type="button"
            disabled={busy}
            onClick={() => void onRefresh()}
          >
            {busy ? "Refreshing…" : "Refresh shared store"}
          </button>
        )}
      </div>
      {!source
        ? canManage
          ? connectionForm
          : <p className="source-empty">No shared store has been connected.</p>
        : (
          <>
            <dl className="source-provenance">
              <div>
                <dt>Status</dt>
                <dd className={`source-status ${source.status}`}>
                  {source.status.replace("_", " ")}
                </dd>
              </div>
              <div>
                <dt>Endpoint</dt>
                <dd>{source.endpoint}</dd>
              </div>
              <div>
                <dt>Bucket and path</dt>
                <dd>{source.bucket}/{source.path}</dd>
              </div>
              <div>
                <dt>Source revision</dt>
                <dd>
                  <code>{source.revision?.slice(0, 12) ?? "None"}</code>
                </dd>
              </div>
              <div>
                <dt>Last successful sync</dt>
                <dd>
                  {source.lastSyncedAt
                    ? new Date(source.lastSyncedAt).toLocaleString()
                    : "Not yet"}
                </dd>
              </div>
              <div>
                <dt>Credentials</dt>
                <dd>Encrypted and stored server-side</dd>
              </div>
            </dl>
            {source.error && (
              <p className="source-error" role="alert">{source.error}</p>
            )}
            <SourceIssues issues={source.issues} />
            {canManage && source.status === "sync_failed" &&
              !source.revision && connectionForm}
          </>
        )}
      {error && <p className="source-error" role="alert">{error}</p>}
      <ImportGrid sourceId="shared" imports={imports} onOpen={onOpen} />
    </section>
  );
}

function AutomationPanel() {
  const [state, setState] = useState<AutomationState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const response = await api("/api/automation");
    const result = await response.json() as AutomationState & {
      error?: string;
    };
    if (!response.ok) throw new Error(result.error ?? "Automation unavailable");
    setState(result);
  }, []);
  useEffect(() => {
    load().catch((cause) => setError(cause.message));
  }, [load]);
  const run = async () => {
    setBusy(true);
    setError("");
    const response = await api("/api/automation/run", { method: "POST" });
    const result = await response.json() as AutomationState & {
      error?: string;
    };
    setBusy(false);
    if (!response.ok) {
      setError(result.error ?? "Source checks failed");
      return;
    }
    setState(result);
  };
  const schedule = !state?.intervalMs
    ? "Scheduled checks disabled"
    : `Scheduled every ${Math.round(state.intervalMs / 60_000)} minutes`;
  return (
    <section className="automation-panel" aria-labelledby="automation-heading">
      <div className="source-heading">
        <div>
          <p className="eyebrow">Source operations</p>
          <h2 id="automation-heading">Checks and proposals</h2>
          <p>
            {schedule}. Each source is isolated and receives at most one
            automatic retry.
          </p>
        </div>
        <button
          className="primary"
          type="button"
          disabled={busy || state?.running}
          onClick={() =>
            void run()}
        >
          {busy || state?.running ? "Running checks…" : "Run checks now"}
        </button>
      </div>
      {error && <p className="source-error" role="alert">{error}</p>}
      <div className="automation-runs">
        {state?.runs.map((run, index) => (
          <details key={run.id} open={index === 0}>
            <summary>
              <strong className={`automation-status ${run.status}`}>
                {run.status}
              </strong>
              <span>{run.trigger}</span>
              <time>{new Date(run.startedAt).toLocaleString()}</time>
            </summary>
            <div className="automation-attempts">
              {run.attempts.map((attempt) => (
                <section key={attempt.id}>
                  <div>
                    <strong>
                      {attempt.job === "source_check"
                        ? `${attempt.sourceId} source`
                        : "Broken links"}
                    </strong>
                    <span>
                      Attempt {attempt.attempt} · {attempt.status}
                    </span>
                  </div>
                  {attempt.error && <p>{attempt.error}</p>}
                  {attempt.result?.conceptCount !== undefined && (
                    <p>
                      {attempt.result.conceptCount} healthy concepts indexed
                    </p>
                  )}
                  {attempt.result?.checkedConcepts !== undefined && (
                    <p>{attempt.result.checkedConcepts} concepts checked</p>
                  )}
                  {attempt.result?.proposals?.map((proposal) => (
                    <div
                      className="automation-proposal"
                      key={`${proposal.sourceId}-${proposal.path}-${proposal.href}`}
                    >
                      <strong>Fix broken link</strong>
                      <code>{proposal.path}</code>
                      <span>{proposal.href} → {proposal.target}</span>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </details>
        ))}
        {state && state.runs.length === 0 && (
          <p className="source-empty">No source checks have run yet.</p>
        )}
      </div>
    </section>
  );
}

function ArtifactFrame({ artifact }: { artifact: Artifact }) {
  return (
    <iframe
      className="artifact-frame"
      title={artifact.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      allow=""
      loading="lazy"
      src={artifact.type === "https_url" ? artifact.url : undefined}
      srcDoc={artifact.type === "inline_html" ? artifact.document : undefined}
    />
  );
}

function ArtifactPanel(
  { conceptId, conceptActive }: { conceptId: string; conceptActive: boolean },
) {
  const [state, setState] = useState<ArtifactState | null>(null);
  const [type, setType] = useState<"inline_html" | "https_url">("inline_html");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const response = await api(
      `/api/artifacts?conceptId=${encodeURIComponent(conceptId)}`,
    );
    const result = await response.json() as ArtifactState & { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Artifacts unavailable");
    setState(result);
  }, [conceptId]);
  useEffect(() => {
    load().catch((cause) => setError(cause.message));
  }, [load]);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy("create");
    setError("");
    const response = await api("/api/artifacts", {
      method: "POST",
      body: JSON.stringify({
        conceptId,
        title: fields.get("title"),
        type,
        content: fields.get("content"),
      }),
    });
    const result = await response.json().catch(() => ({})) as {
      error?: string;
    };
    setBusy("");
    if (!response.ok) {
      setError(result.error ?? "Artifact creation failed");
      return;
    }
    form.reset();
    setType("inline_html");
    await load();
  };
  const revise = async (
    event: FormEvent<HTMLFormElement>,
    artifact: Artifact,
  ) => {
    event.preventDefault();
    const content = String(
      new FormData(event.currentTarget).get("content") ?? "",
    );
    setBusy(artifact.id);
    setError("");
    const response = await api(`/api/artifacts/${artifact.id}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    });
    const result = await response.json().catch(() => ({})) as {
      error?: string;
    };
    setBusy("");
    if (!response.ok) {
      setError(result.error ?? "Artifact update failed");
      return;
    }
    await load();
  };
  const publish = async (artifact: Artifact) => {
    setBusy(artifact.id);
    setError("");
    const response = await api(`/api/artifacts/${artifact.id}/publish`, {
      method: "POST",
    });
    const result = await response.json().catch(() => ({})) as {
      error?: string;
    };
    setBusy("");
    if (!response.ok) {
      setError(result.error ?? "Artifact activation failed");
      return;
    }
    await load();
  };

  if (!state && !error) {
    return <div className="artifact-loading">Loading artifacts…</div>;
  }
  if (state && !state.canEdit && state.artifacts.length === 0) return null;
  return (
    <section className="artifact-panel" aria-labelledby="artifact-heading">
      <div className="artifact-heading">
        <div>
          <p className="eyebrow">Interactive artifacts</p>
          <h2 id="artifact-heading">Reviewed tools and dashboards</h2>
          <p>
            Artifacts are separate from portable Markdown and run in a
            restricted iframe.
          </p>
        </div>
      </div>
      {state?.canEdit && conceptActive && (
        <form
          className="artifact-form"
          onSubmit={(event) => void create(event)}
        >
          <label>
            Title
            <input name="title" maxLength={100} required />
          </label>
          <label>
            Type
            <select
              value={type}
              onChange={(event) =>
                setType(event.target.value as "inline_html" | "https_url")}
            >
              <option value="inline_html">Inline HTML</option>
              <option value="https_url">HTTPS application</option>
            </select>
          </label>
          <label className="artifact-content">
            {type === "inline_html" ? "HTML" : "HTTPS URL"}
            <textarea
              name="content"
              rows={type === "inline_html" ? 7 : 2}
              placeholder={type === "inline_html"
                ? "<h2>Calculator</h2><script>…</script>"
                : "https://apps.example.com/dashboard"}
              required
            />
          </label>
          {type === "https_url" && (
            <p className="artifact-hosts">
              Allowed hosts:{" "}
              {state.allowedHosts.join(", ") || "none configured"}
            </p>
          )}
          <button
            className="primary"
            type="submit"
            disabled={busy === "create"}
          >
            {busy === "create" ? "Creating…" : "Create draft artifact"}
          </button>
        </form>
      )}
      {error && <p className="source-error" role="alert">{error}</p>}
      <div className="artifact-grid">
        {state?.artifacts.map((artifact) => (
          <article key={`${artifact.id}-${artifact.version}`}>
            <header>
              <div>
                <span className={`artifact-status ${artifact.status}`}>
                  {artifact.status.replace("_", " ")}
                </span>
                <span>
                  {artifact.type === "inline_html" ? "HTML" : "HTTPS URL"}
                </span>
              </div>
              <h3>{artifact.title}</h3>
              <p>
                Version {artifact.version}
                {artifact.liveVersion
                  ? ` · live ${artifact.liveVersion}`
                  : " · not live"}
              </p>
            </header>
            <ArtifactFrame artifact={artifact} />
            {state.canEdit && conceptActive && artifact.content !== undefined &&
              (
                <form
                  className="artifact-revision-form"
                  onSubmit={(event) => void revise(event, artifact)}
                >
                  <label>
                    Draft source
                    <textarea
                      key={artifact.version}
                      name="content"
                      rows={5}
                      defaultValue={artifact.content}
                      required
                    />
                  </label>
                  <button type="submit" disabled={busy === artifact.id}>
                    Save new version
                  </button>
                  {state.canPublish && artifact.status !== "live" && (
                    <button
                      className="primary"
                      type="button"
                      disabled={busy === artifact.id}
                      onClick={() => void publish(artifact)}
                    >
                      Make version {artifact.version} live
                    </button>
                  )}
                </form>
              )}
            {state.canEdit && artifact.versions.length > 0 && (
              <details className="artifact-history">
                <summary>{artifact.versions.length} versions</summary>
                {artifact.versions.map((version) => (
                  <p key={version.number}>
                    Version {version.number} · {version.approvedAt
                      ? `made live ${
                        new Date(version.approvedAt).toLocaleString()
                      }`
                      : "draft"}
                  </p>
                ))}
              </details>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function SearchPanel(
  { onOpenHub, onOpenImported }: {
    onOpenHub: (id: string) => void;
    onOpenImported: (
      sourceId: string,
      path: string,
    ) => Promise<unknown>;
  },
) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [tag, setTag] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (params = new URLSearchParams()) => {
    setBusy(true);
    setError("");
    const response = await api(`/api/search?${params}`);
    const body = await response.json() as SearchResponse & { error?: string };
    setBusy(false);
    if (!response.ok) {
      setError(body.error ?? "Search unavailable");
      return;
    }
    setResult(body);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (type) params.set("type", type);
    if (tag) params.set("tag", tag);
    if (includeArchived) params.set("includeArchived", "true");
    void load(params);
  };
  const open = (item: SearchRelationship) => {
    if (item.kind === "hub-native") return onOpenHub(item.id);
    if (item.sourceId !== "hub" && item.path) {
      void onOpenImported(item.sourceId, item.path);
    }
  };
  const relationships = (
    label: string,
    items: SearchRelationship[],
  ) =>
    items.length > 0 && (
      <div className="search-relationships">
        <strong>{label}</strong>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => open(item)}
          >
            {item.title}
            <small>{item.sourceId === "hub" ? "Hub" : item.sourceId}</small>
          </button>
        ))}
      </div>
    );

  return (
    <section className="search-panel" aria-labelledby="search-heading">
      <div className="source-page-heading">
        <p className="eyebrow">Permission-aware discovery</p>
        <h1 id="search-heading">Search company knowledge</h1>
        <p>Browse hub-native, Git, and shared-store knowledge in one view.</p>
      </div>
      <form className="search-form" role="search" onSubmit={submit}>
        <label className="search-query">
          Search
          <input
            type="search"
            value={query}
            maxLength={120}
            placeholder="Incident response, onboarding, owner…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          Type
          <select
            value={type}
            onChange={(event) => setType(event.target.value)}
          >
            <option value="">All types</option>
            {result?.facets.types.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          Tag
          <select value={tag} onChange={(event) => setTag(event.target.value)}>
            <option value="">All tags</option>
            {result?.facets.tags.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>
        {result?.canIncludeArchived && (
          <label className="archived-filter">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
            />
            Include archived
          </label>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>
      {error && <p className="source-error" role="alert">{error}</p>}
      <div className="search-summary" aria-live="polite">
        {busy
          ? "Checking access…"
          : `${result?.results.length ?? 0} accessible concepts`}
      </div>
      <div className="search-results">
        {result?.results.map((item) => (
          <article key={item.id}>
            <div className="search-result-heading">
              <div>
                <span className={`knowledge-kind ${item.kind}`}>
                  {item.kind === "hub-native" ? "Hub-native" : "Imported"}
                </span>
                <span className={`trust-status ${item.trust}`}>
                  {item.trust.replace("_", " ")}
                </span>
              </div>
              <button type="button" onClick={() => open(item)}>
                {item.title}
              </button>
              <p>{item.snippet}</p>
            </div>
            <dl className="search-metadata">
              <div>
                <dt>Type</dt>
                <dd>{item.type}</dd>
              </div>
              <div>
                <dt>Owner</dt>
                <dd>{item.owner}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{item.sourceLabel}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{item.status}</dd>
              </div>
            </dl>
            {item.tags.length > 0 && (
              <div className="search-tags">
                {item.tags.map((itemTag) => (
                  <span key={itemTag}>{itemTag}</span>
                ))}
              </div>
            )}
            {relationships("Links to", item.links)}
            {relationships("Linked from", item.backlinks)}
          </article>
        ))}
        {!busy && result?.results.length === 0 && (
          <p className="search-empty">
            No accessible knowledge matches these filters.
          </p>
        )}
      </div>
    </section>
  );
}

function HomePanel(
  {
    concepts,
    spaces,
    imports,
    repositories,
    shared,
    canEdit,
    onOpenConcept,
    onOpenImported,
    onCreate,
    onSearch,
    onSources,
  }: {
    concepts: Concept[];
    spaces: Space[];
    imports: ImportedConcept[];
    repositories: RepositorySource[];
    shared: SharedSource | null;
    canEdit: boolean;
    onOpenConcept: (id: string) => void;
    onOpenImported: (
      sourceId: string,
      path: string,
    ) => Promise<unknown>;
    onCreate: () => void;
    onSearch: () => void;
    onSources: () => void;
  },
) {
  const recentConcepts = [...concepts].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  ).slice(0, 6);
  const recentImports = [...imports].sort((left, right) =>
    right.importedAt.localeCompare(left.importedAt)
  ).slice(0, 4);
  const unpublished =
    concepts.filter((item) =>
      item.status === "active" && !item.publishedRevision
    ).length;
  const archived = concepts.filter((item) => item.status === "archived")
    .length;
  const connected = [...repositories, shared].filter(Boolean);
  const sourceAttention =
    connected.filter((item) => item?.status !== "current").length;

  return (
    <section className="home-panel">
      <header className="home-heading">
        <div>
          <p className="eyebrow">Company knowledge</p>
          <h1>Your knowledge hub</h1>
          <p>Everything here already follows your access permissions.</p>
        </div>
        <div className="home-actions">
          <button type="button" onClick={onSearch}>Search knowledge</button>
          {canEdit && (
            <button className="primary" type="button" onClick={onCreate}>
              Create document
            </button>
          )}
        </div>
      </header>
      <div className="home-metrics">
        <button type="button" onClick={onSearch}>
          <strong>{concepts.length + imports.length}</strong>
          <span>Accessible documents</span>
        </button>
        <div>
          <strong>{spaces.length}</strong>
          <span>Knowledge spaces</span>
        </div>
        {canEdit && (
          <div>
            <strong>{unpublished}</strong>
            <span>Unpublished drafts</span>
          </div>
        )}
        {canEdit && (
          <div>
            <strong>{archived}</strong>
            <span>Archived documents</span>
          </div>
        )}
      </div>
      <div className="home-columns">
        <section className="home-recent">
          <div className="home-section-heading">
            <h2>Recently updated</h2>
            {canEdit && <button type="button" onClick={onCreate}>New</button>}
          </div>
          {recentConcepts.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => onOpenConcept(item.id)}
            >
              <span className="knowledge-kind">{item.type}</span>
              <strong>{item.title}</strong>
              <small>
                {item.intent} · {item.space} · {item.status.replace("_", " ")}
              </small>
              <time>{new Date(item.updatedAt).toLocaleDateString()}</time>
            </button>
          ))}
          {!recentConcepts.length && (
            <p className="home-empty">
              No hub-native documents are visible yet.
            </p>
          )}
        </section>
        <section className="home-overview">
          <div className="home-section-heading">
            <h2>Connected sources</h2>
            <button type="button" onClick={onSources}>Open</button>
          </div>
          <button
            className="source-health-card"
            type="button"
            onClick={onSources}
          >
            <strong>{connected.length} connected</strong>
            <span>
              {sourceAttention
                ? `${sourceAttention} need attention`
                : connected.length
                ? "All connected sources are healthy"
                : "Connect your first source"}
            </span>
            <small>{imports.length} imported documents</small>
          </button>
          {recentImports.length > 0 && (
            <>
              <h3>Recently imported</h3>
              <div className="home-imports">
                {recentImports.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() =>
                      void onOpenImported(item.sourceId, item.path)}
                  >
                    <strong>{item.title}</strong>
                    <small>
                      {item.sourceId === "shared" ? "Shared store" : "Git"}
                    </small>
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </section>
  );
}

function WorkTracePanel(
  { concept, concepts, canEdit, busy, onCreate, onFold }: {
    concept: Concept;
    concepts: Concept[];
    canEdit: boolean;
    busy: boolean;
    onCreate: (event: FormEvent<HTMLFormElement>) => Promise<void>;
    onFold: (
      trace: WorkTrace,
      event: FormEvent<HTMLFormElement>,
    ) => Promise<void>;
  },
) {
  const now = new Date();
  const today = `${now.getFullYear()}-${
    String(now.getMonth() + 1).padStart(
      2,
      "0",
    )
  }-${String(now.getDate()).padStart(2, "0")}`;
  const canonicalTargets = concepts.filter((item) =>
    item.intent === "canonical" && item.status === "active"
  );
  return (
    <section className="work-trace-panel" aria-labelledby="work-trace-heading">
      <header>
        <p className="eyebrow">Historical truth</p>
        <h2 id="work-trace-heading">Work trace</h2>
        <p>
          Keep dated reasons and outcomes without turning the current document
          into a work log.
        </p>
      </header>
      {canEdit && concept.status === "active" && (
        <details className="trace-create">
          <summary>Record work</summary>
          <form
            onSubmit={(event) =>
              void onCreate(event)}
          >
            <label>
              Kind
              <select name="kind" defaultValue="change">
                <option value="change">Change</option>
                <option value="decision">Decision</option>
                <option value="incident">Incident</option>
                <option value="outcome">Outcome</option>
              </select>
            </label>
            <label>
              Date
              <input
                name="occurredAt"
                type="date"
                defaultValue={today}
                required
              />
            </label>
            <label className="trace-title">
              Title
              <input name="title" maxLength={100} required />
            </label>
            <label className="trace-summary">
              What happened and why
              <textarea name="summary" rows={4} maxLength={4000} required />
            </label>
            <label className="trace-source">
              Ticket, PR, or source link <span>(optional)</span>
              <input
                name="sourceUrl"
                type="url"
                maxLength={500}
                placeholder="https://github.com/company/project/issues/123"
              />
            </label>
            <button className="primary" type="submit" disabled={busy}>
              Record trace
            </button>
          </form>
        </details>
      )}
      <div className="work-trace-list">
        {concept.workTraces.map((trace) => (
          <article key={trace.id}>
            <div className="trace-heading">
              <span>{trace.kind}</span>
              <time dateTime={trace.occurredAt}>{trace.occurredAt}</time>
            </div>
            <h3>{trace.title}</h3>
            {trace.conceptId !== concept.id && (
              <p className="trace-origin">From {trace.conceptTitle}</p>
            )}
            <p>{trace.summary}</p>
            {trace.sourceUrl && (
              <a href={trace.sourceUrl} target="_blank" rel="noreferrer">
                Open source work
              </a>
            )}
            {trace.foldedIntoConceptId
              ? (
                <div className="trace-folded">
                  Folded into <strong>{trace.foldedIntoTitle}</strong>
                  {trace.foldedKnowledge && <p>{trace.foldedKnowledge}</p>}
                </div>
              )
              : canEdit && trace.conceptId === concept.id &&
                  canonicalTargets.length > 0
              ? (
                <details className="trace-fold">
                  <summary>Fold lasting knowledge</summary>
                  <form onSubmit={(event) => void onFold(trace, event)}>
                    <label>
                      Canonical destination
                      <select name="targetConceptId" required>
                        {canonicalTargets.map((target) => (
                          <option key={target.id} value={target.id}>
                            {target.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Lasting knowledge
                      <textarea
                        name="knowledge"
                        rows={4}
                        maxLength={10000}
                        required
                      />
                    </label>
                    <button type="submit" disabled={busy}>
                      Fold into document
                    </button>
                  </form>
                </details>
              )
              : null}
          </article>
        ))}
        {!concept.workTraces.length && (
          <p className="trace-empty">No work trace has been recorded.</p>
        )}
      </div>
    </section>
  );
}

function HubCreatePanel(
  {
    spaces,
    busy,
    error,
    onCreateSpace,
    onCreateConcept,
    onRenameSpace,
    onDeleteSpace,
    onCancel,
  }: {
    spaces: Space[];
    busy: boolean;
    error: string;
    onCreateSpace: (event: FormEvent<HTMLFormElement>) => Promise<void>;
    onCreateConcept: (event: FormEvent<HTMLFormElement>) => Promise<void>;
    onRenameSpace: (
      event: FormEvent<HTMLFormElement>,
      space: Space,
    ) => Promise<void>;
    onDeleteSpace: (space: Space) => Promise<void>;
    onCancel: () => void;
  },
) {
  return (
    <section className="hub-create-panel">
      <div className="source-page-heading">
        <p className="eyebrow">Hub-native knowledge</p>
        <h1>Create and manage knowledge</h1>
        <p>Documents inherit access from their space.</p>
      </div>
      <form onSubmit={(event) => void onCreateConcept(event)}>
        <h2>New document</h2>
        <label>
          Title
          <input name="title" maxLength={100} required autoFocus />
        </label>
        <label>
          Type
          <input name="type" maxLength={50} defaultValue="Policy" required />
        </label>
        <label>
          Intent
          <select name="intent" defaultValue="canonical" required>
            <option value="canonical">Maintained knowledge</option>
            <option value="working">Working document</option>
            <option value="evidence">Evidence</option>
            <option value="ephemeral">Ephemeral notes</option>
          </select>
        </label>
        <label>
          Space
          <select name="spaceId" required>
            {spaces.map((space) => (
              <option key={space.id} value={space.id}>{space.name}</option>
            ))}
          </select>
        </label>
        <button className="primary" type="submit" disabled={busy}>
          Create document
        </button>
      </form>
      <form onSubmit={(event) => void onCreateSpace(event)}>
        <h2>New space</h2>
        <label>
          Name
          <input name="name" maxLength={60} required />
        </label>
        <button type="submit" disabled={busy}>Create space</button>
      </form>
      <section className="space-management">
        <h2>Manage spaces</h2>
        {spaces.map((space) => (
          <form
            key={space.id}
            onSubmit={(event) => void onRenameSpace(event, space)}
          >
            <label>
              Space name
              <input
                name="name"
                maxLength={60}
                defaultValue={space.name}
                required
              />
            </label>
            <span>{space.count} documents</span>
            <button type="submit" disabled={busy}>Rename</button>
            {space.id !== "policies" && (
              <button
                type="button"
                disabled={busy || space.count > 0}
                onClick={() => void onDeleteSpace(space)}
              >
                Delete empty space
              </button>
            )}
          </form>
        ))}
      </section>
      {error && <p className="source-error" role="alert">{error}</p>}
      <button className="text-button" type="button" onClick={onCancel}>
        Cancel
      </button>
    </section>
  );
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [fatal, setFatal] = useState("");
  const [concept, setConcept] = useState<Concept | null>(null);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [conceptLoaded, setConceptLoaded] = useState(false);
  const [hubReady, setHubReady] = useState(false);
  const [sourcesReady, setSourcesReady] = useState(false);
  const [routeError, setRouteError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [documentSettingsOpen, setDocumentSettingsOpen] = useState(false);
  const [initialMarkdown, setInitialMarkdown] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "failed">(
    "saved",
  );
  const [accessOpen, setAccessOpen] = useState(false);
  const [view, setView] = useState<"draft" | "published">("draft");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [editorVersion, setEditorVersion] = useState(0);
  const [repositories, setRepositories] = useState<RepositorySource[]>([]);
  const [sharedSource, setSharedSource] = useState<SharedSource | null>(null);
  const [imports, setImports] = useState<ImportedConcept[]>([]);
  const [imported, setImported] = useState<ImportedConcept | null>(null);
  const [homeOpen, setHomeOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sharedBusy, setSharedBusy] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [sharedError, setSharedError] = useState("");
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
  const loadSources = useCallback(async () => {
    const [sourceResponse, importsResponse] = await Promise.all([
      api("/api/sources"),
      api("/api/imports"),
    ]);
    if (!sourceResponse.ok || !importsResponse.ok) {
      throw new Error("Connected sources unavailable");
    }
    const sources = await sourceResponse.json() as Sources;
    setRepositories(sources.repositories);
    setSharedSource(sources.shared);
    setImports(await importsResponse.json());
  }, []);
  const openHubConcept = useCallback(async (id: string, record = true) => {
    setConceptLoaded(false);
    setRouteError("");
    const response = await api(conceptPath(id));
    const result = await response.json() as Concept & { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Concept unavailable");
    setConcept(result);
    const content = bootstrap?.canEdit ? result.draft : result.published;
    setInitialMarkdown(content ?? null);
    setMarkdown(content ?? "");
    setView(bootstrap?.canEdit ? "draft" : "published");
    setEditorVersion((current) => current + 1);
    setConceptLoaded(true);
    setCreateOpen(false);
    setDocumentSettingsOpen(false);
    setImported(null);
    setHomeOpen(false);
    setSourceOpen(false);
    setSearchOpen(false);
    setAccessOpen(false);
    if (record) setBrowserRoute({ kind: "concept", id });
  }, [bootstrap?.canEdit]);
  const refreshHubLists = useCallback(async () => {
    const [spacesResponse, conceptsResponse] = await Promise.all([
      api("/api/spaces"),
      api(`/api/concepts${bootstrap?.canEdit ? "?include=archived" : ""}`),
    ]);
    if (!spacesResponse.ok || !conceptsResponse.ok) {
      throw new Error("Hub-native knowledge unavailable");
    }
    const nextSpaces = await spacesResponse.json() as Space[];
    const nextConcepts = await conceptsResponse.json() as Concept[];
    setSpaces(nextSpaces);
    setConcepts(nextConcepts);
    return nextConcepts;
  }, [bootstrap?.canEdit]);

  useEffect(() => {
    refresh().catch((error) => setFatal(error.message));
  }, [refresh]);
  useEffect(() => {
    if (!bootstrap?.canView) return;
    const load = async () => {
      setConceptLoaded(false);
      setDocumentSettingsOpen(false);
      await refreshHubLists();
      setConceptLoaded(true);
      setHubReady(true);
    };
    load().catch((error) => setFatal(error.message));
  }, [bootstrap?.canView, refreshHubLists]);
  useEffect(() => {
    if (!bootstrap?.canView) return;
    loadSources().catch((error) => setSourceError(error.message)).finally(() =>
      setSourcesReady(true)
    );
  }, [bootstrap?.canView, loadSources]);

  const signOut = () => {
    void api("/api/auth/sign-out", { method: "POST" }).finally(() => {
      setBootstrap({ user: null });
      setConcept(null);
      setConcepts([]);
      setSpaces([]);
      setConceptLoaded(false);
      setHubReady(false);
      setSourcesReady(false);
      setRouteError("");
      setInitialMarkdown(null);
      setRepositories([]);
      setSharedSource(null);
      setImports([]);
      setImported(null);
      setHomeOpen(false);
      setSearchOpen(false);
    });
  };
  const saveMarkdown = useCallback((content: string) => {
    if (!bootstrap?.canEdit || !concept) return;
    setMarkdown(content);
    setSaveState("saving");
    if (saveTimer.current) globalThis.clearTimeout(saveTimer.current);
    saveTimer.current = globalThis.setTimeout(() => {
      api(conceptPath(concept.id), {
        method: "PUT",
        body: content,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      }).then((response) => {
        if (!response.ok) throw new Error("save failed");
        setSaveState("saved");
      }).catch(() => setSaveState("failed"));
    }, 300);
  }, [bootstrap?.canEdit, concept]);

  const lifecycle = async (path: string, body?: unknown) => {
    if (!concept) return null;
    setActionBusy(true);
    setActionError("");
    if (saveTimer.current) globalThis.clearTimeout(saveTimer.current);
    const response = await api(`${conceptPath(concept.id)}/${path}`, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json() as Concept & { error?: string };
    setActionBusy(false);
    if (!response.ok) {
      setActionError(result.error ?? "Action failed");
      return null;
    }
    setConcept(result);
    await refreshHubLists().catch(() => {});
    return result;
  };

  const createSpace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name") ?? "");
    setActionBusy(true);
    setActionError("");
    const response = await api("/api/spaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    const result = await response.json() as Space & { error?: string };
    setActionBusy(false);
    if (!response.ok) return setActionError(result.error ?? "Creation failed");
    form.reset();
    await refreshHubLists();
  };

  const renameSpace = async (
    event: FormEvent<HTMLFormElement>,
    space: Space,
  ) => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "");
    setActionBusy(true);
    setActionError("");
    const response = await api(`/api/spaces/${space.id}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    });
    const result = await response.json() as Space & { error?: string };
    setActionBusy(false);
    if (!response.ok) return setActionError(result.error ?? "Rename failed");
    if (concept?.spaceId === space.id) {
      setConcept({ ...concept, space: result.name });
    }
    await refreshHubLists();
  };

  const deleteSpace = async (space: Space) => {
    setActionBusy(true);
    setActionError("");
    const response = await api(`/api/spaces/${space.id}`, {
      method: "DELETE",
    });
    setActionBusy(false);
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as {
        error?: string;
      };
      return setActionError(result.error ?? "Deletion failed");
    }
    await refreshHubLists();
  };

  const createConcept = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setActionBusy(true);
    setActionError("");
    const response = await api("/api/concepts", {
      method: "POST",
      body: JSON.stringify({
        title: fields.get("title"),
        type: fields.get("type"),
        intent: fields.get("intent"),
        spaceId: fields.get("spaceId"),
      }),
    });
    const result = await response.json() as Concept & { error?: string };
    setActionBusy(false);
    if (!response.ok) return setActionError(result.error ?? "Creation failed");
    await refreshHubLists();
    await openHubConcept(result.id);
  };

  const updateConcept = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!concept) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setActionBusy(true);
    setActionError("");
    const response = await api(`${conceptPath(concept.id)}/metadata`, {
      method: "PUT",
      body: JSON.stringify({
        title: fields.get("title"),
        type: fields.get("type"),
        intent: fields.get("intent"),
        spaceId: fields.get("spaceId"),
      }),
    });
    const result = await response.json() as Concept & { error?: string };
    setActionBusy(false);
    if (!response.ok) return setActionError(result.error ?? "Update failed");
    setConcept(result);
    setDocumentSettingsOpen(false);
    await refreshHubLists();
  };

  const publish = async () => {
    const result = await lifecycle("publish", { markdown });
    if (result) setSaveState("saved");
  };

  const restoreRevision = async (number: number) => {
    const result = await lifecycle(`revisions/${number}/restore`);
    if (!result?.draft) return;
    setInitialMarkdown(result.draft);
    setMarkdown(result.draft);
    setEditorVersion((current) => current + 1);
    setView("draft");
    setHistoryOpen(false);
  };

  const createWorkTrace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!concept) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setActionBusy(true);
    setActionError("");
    const response = await api(`${conceptPath(concept.id)}/traces`, {
      method: "POST",
      body: JSON.stringify({
        kind: fields.get("kind"),
        title: fields.get("title"),
        summary: fields.get("summary"),
        occurredAt: fields.get("occurredAt"),
        sourceUrl: fields.get("sourceUrl"),
      }),
    });
    const result = await response.json() as Concept & { error?: string };
    setActionBusy(false);
    if (!response.ok) {
      return setActionError(result.error ?? "Work trace failed");
    }
    setConcept(result);
    form.reset();
  };

  const foldWorkTrace = async (
    trace: WorkTrace,
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (!concept) return;
    const fields = new FormData(event.currentTarget);
    const targetConceptId = String(fields.get("targetConceptId") ?? "");
    setActionBusy(true);
    setActionError("");
    const response = await api(
      `${conceptPath(concept.id)}/traces/${trace.id}/fold`,
      {
        method: "POST",
        body: JSON.stringify({
          targetConceptId,
          knowledge: fields.get("knowledge"),
          ...(targetConceptId === concept.id
            ? { targetMarkdown: markdown }
            : {}),
        }),
      },
    );
    const result = await response.json() as Concept & { error?: string };
    setActionBusy(false);
    if (!response.ok) return setActionError(result.error ?? "Fold failed");
    setConcept(result);
    if (targetConceptId === concept.id && result.draft) {
      setInitialMarkdown(result.draft);
      setMarkdown(result.draft);
      setEditorVersion((current) => current + 1);
    }
    await refreshHubLists();
  };

  const connectRepository = async (
    source: RepositorySource | null,
    repositoryUrl: string,
    folder: string,
    username: string,
    token: string,
  ) => {
    setSourceBusy(true);
    setSourceError("");
    const response = await api(
      `/api/sources/repositories${source ? `/${source.id}` : ""}`,
      {
        method: "POST",
        body: JSON.stringify({ repositoryUrl, folder, username, token }),
      },
    );
    const result = await response.json() as RepositorySource & {
      error?: string;
    };
    setSourceBusy(false);
    if (!response.ok) {
      setSourceError(result.error ?? "Repository connection failed");
    }
    await loadSources().catch(() => {});
  };

  const refreshRepository = async (sourceId: string) => {
    setSourceBusy(true);
    setSourceError("");
    const response = await api(
      `/api/sources/repositories/${sourceId}/refresh`,
      {
        method: "POST",
      },
    );
    const result = await response.json() as RepositorySource & {
      error?: string;
    };
    setSourceBusy(false);
    if (!response.ok) {
      setSourceError(result.error ?? "Repository refresh failed");
    }
    await loadSources().catch(() => {});
    if (imported) {
      const current = await api(
        `/api/imported?source=${imported.sourceId}&path=${
          encodeURIComponent(imported.path)
        }`,
      );
      setImported(current.ok ? await current.json() : null);
    }
  };

  const disconnectRepository = async (source: RepositorySource) => {
    setSourceBusy(true);
    setSourceError("");
    const response = await api(`/api/sources/repositories/${source.id}`, {
      method: "DELETE",
      body: JSON.stringify({ confirm: source.id }),
    });
    setSourceBusy(false);
    if (!response.ok) {
      const result = await response.json() as { error?: string };
      setSourceError(result.error ?? "Repository disconnect failed");
      return;
    }
    if (imported?.sourceId === source.id) setImported(null);
    await loadSources().catch(() => {});
  };

  const connectSharedSource = async (values: Record<string, string>) => {
    setSharedBusy(true);
    setSharedError("");
    const response = await api("/api/sources/shared", {
      method: "POST",
      body: JSON.stringify(values),
    });
    const result = await response.json() as SharedSource & { error?: string };
    setSharedBusy(false);
    if (result?.id === "shared") setSharedSource(result);
    if (!response.ok) {
      setSharedError(result.error ?? "Shared store connection failed");
    }
    await loadSources().catch(() => {});
  };

  const refreshSharedSource = async () => {
    setSharedBusy(true);
    setSharedError("");
    const response = await api("/api/sources/shared/refresh", {
      method: "POST",
    });
    const result = await response.json() as SharedSource & { error?: string };
    setSharedBusy(false);
    if (result?.id === "shared") setSharedSource(result);
    if (!response.ok) {
      setSharedError(result.error ?? "Shared store refresh failed");
    }
    await loadSources().catch(() => {});
  };

  const openImported = async (
    sourceId: string,
    path: string,
    record = true,
  ) => {
    setSourceError("");
    setRouteError("");
    const response = await api(
      `/api/imported?source=${sourceId}&path=${encodeURIComponent(path)}`,
    );
    const result = await response.json() as ImportedConcept & {
      error?: string;
    };
    if (!response.ok) {
      setSourceError(result.error ?? "Import unavailable");
      return false;
    }
    setImported(result);
    setHomeOpen(false);
    setSourceOpen(false);
    setSearchOpen(false);
    setAccessOpen(false);
    if (record) setBrowserRoute({ kind: "imported", sourceId, path });
    return true;
  };

  const showHubConcept = (id?: string, record = true) => {
    setRouteError("");
    setImported(null);
    setHomeOpen(false);
    setSourceOpen(false);
    setSearchOpen(false);
    setCreateOpen(false);
    setDocumentSettingsOpen(false);
    if (id && id !== concept?.id) {
      void openHubConcept(id, record).catch((error) =>
        setActionError(error.message)
      );
    } else if (id && record) {
      setBrowserRoute({ kind: "concept", id });
    } else if (!id && concept) {
      if (record) setBrowserRoute({ kind: "concept", id: concept.id });
    } else if (!id) {
      setHomeOpen(true);
      if (record) setBrowserRoute({ kind: "home" });
    }
  };
  const showHome = (record = true) => {
    setRouteError("");
    setHomeOpen(true);
    setImported(null);
    setSourceOpen(false);
    setSearchOpen(false);
    setCreateOpen(false);
    setDocumentSettingsOpen(false);
    setAccessOpen(false);
    if (record) setBrowserRoute({ kind: "home" });
  };
  const showSearch = (record = true) => {
    setRouteError("");
    setHomeOpen(false);
    setSearchOpen(true);
    setSourceOpen(false);
    setImported(null);
    setCreateOpen(false);
    setAccessOpen(false);
    if (record) setBrowserRoute({ kind: "search" });
  };
  const showSources = (record = true) => {
    setRouteError("");
    setHomeOpen(false);
    setImported(null);
    setSourceOpen(true);
    setSearchOpen(false);
    setCreateOpen(false);
    setAccessOpen(false);
    if (record) setBrowserRoute({ kind: "sources" });
  };
  const showCreate = (record = true) => {
    setRouteError("");
    setHomeOpen(false);
    setCreateOpen(true);
    setDocumentSettingsOpen(false);
    setImported(null);
    setSourceOpen(false);
    setSearchOpen(false);
    setAccessOpen(false);
    setActionError("");
    if (record) setBrowserRoute({ kind: "manage" });
  };

  useEffect(() => {
    if (!bootstrap?.canView || !hubReady || !sourcesReady) return;
    let active = true;
    const unavailable = () => {
      if (!active) return;
      setRouteError("This knowledge page is unavailable.");
      setHomeOpen(false);
      setSearchOpen(false);
      setSourceOpen(false);
      setCreateOpen(false);
      setImported(null);
      setConceptLoaded(true);
    };
    const apply = async () => {
      const route = parseAppRoute(globalThis.location.pathname);
      try {
        if (route.kind === "home") return showHome(false);
        if (route.kind === "search") return showSearch(false);
        if (route.kind === "sources") return showSources(false);
        if (route.kind === "manage") {
          if (!bootstrap.canEdit) return unavailable();
          return showCreate(false);
        }
        if (route.kind === "concept") {
          await openHubConcept(route.id, false);
          return;
        }
        if (route.kind === "imported") {
          if (!await openImported(route.sourceId, route.path, false)) {
            unavailable();
          }
          return;
        }
        unavailable();
      } catch {
        unavailable();
      }
    };
    const onPopState = () => void apply();
    void apply();
    globalThis.addEventListener("popstate", onPopState);
    return () => {
      active = false;
      globalThis.removeEventListener("popstate", onPopState);
    };
  }, [
    bootstrap?.canView,
    bootstrap?.canEdit,
    hubReady,
    sourcesReady,
    openHubConcept,
  ]);

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
  const connectedSourceCount = repositories.length +
    Number(Boolean(sharedSource));
  const importedSourceLabel = imported?.sourceId === "shared"
    ? "Shared store"
    : imported?.source && "repositoryUrl" in imported.source
    ? imported.source.repositoryUrl
    : "Git repository";
  return (
    <main className="app-shell">
      <header className="app-header">
        <a
          className="brand"
          href="/"
          aria-label="OKF Hub home"
          onClick={(event) => {
            event.preventDefault();
            showHome();
          }}
        >
          <span>O</span> OKF Hub
        </a>
        <button
          className="mobile-space-button"
          type="button"
          onClick={() => {
            if (imported || sourceOpen || searchOpen) showHubConcept();
            else showSources();
          }}
        >
          {imported || sourceOpen || searchOpen
            ? concept?.space ?? "Knowledge"
            : `Sources (${imports.length})`}
        </button>
        <div className="document-title">
          <small>
            {homeOpen
              ? "Company knowledge /"
              : searchOpen
              ? "Company knowledge /"
              : imported
              ? `${importedSourceLabel} /`
              : `${concept?.space ?? "Hub-native knowledge"} /`}
          </small>
          <strong>
            {homeOpen
              ? "Home"
              : searchOpen
              ? "Search"
              : imported?.title ?? concept?.title ?? "Hub-native knowledge"}
          </strong>
        </div>
        <div className="header-status">
          <span
            className={`connection ${
              homeOpen
                ? "online"
                : searchOpen
                ? "online"
                : imported
                ? imported.source?.status === "sync_failed"
                  ? "offline"
                  : "online"
                : concept?.status === "archived"
                ? "offline"
                : status
            }`}
          >
            <i />
            {searchOpen
              ? "permission filtered"
              : homeOpen
              ? "permission filtered"
              : imported
              ? "read only"
              : concept?.status === "archived"
              ? "archived"
              : bootstrap.canEdit && view === "draft"
              ? status
              : "published"}
          </span>
          <span className="save-state">
            {homeOpen
              ? "Knowledge overview"
              : searchOpen
              ? "Authorised results"
              : imported
              ? imported.sourceId === "shared"
                ? "Shared-store owned"
                : "Repository owned"
              : bootstrap.canEdit
              ? saveState === "saved" ? "Draft saved" : saveState
              : "View only"}
          </span>
        </div>
      </header>
      <aside className="sidebar">
        <p className="section-label">Company knowledge</p>
        <nav>
          <button
            type="button"
            className={searchOpen ? "active" : ""}
            onClick={() => showSearch()}
          >
            ⌕ <span>Search</span>
          </button>
          <button
            type="button"
            className={homeOpen ? "active" : ""}
            onClick={() => showHome()}
          >
            ⌂ <span>Home</span>
          </button>
        </nav>
        <div className="spaces-heading">
          <p className="section-label spaces-label">Spaces</p>
          {bootstrap.canEdit && (
            <button
              type="button"
              onClick={() => showCreate()}
            >
              Manage
            </button>
          )}
        </div>
        <div className="space-list">
          {spaces.map((item, index) => (
            <section key={item.id}>
              <p>
                <i className={`space-dot ${index % 2 ? "gold" : "coral"}`} />
                <span>{item.name}</span>
                <b>{item.count}</b>
              </p>
              <nav className="concept-nav">
                {concepts.filter((candidate) => candidate.spaceId === item.id)
                  .map((candidate) => (
                    <button
                      type="button"
                      className={!homeOpen && !imported && !sourceOpen &&
                          !searchOpen &&
                          !createOpen && concept?.id === candidate.id
                        ? "active"
                        : ""}
                      key={candidate.id}
                      onClick={() => showHubConcept(candidate.id)}
                    >
                      <span>{candidate.title}</span>
                      {candidate.status === "archived" && <b>Archived</b>}
                    </button>
                  ))}
              </nav>
            </section>
          ))}
        </div>
        <nav className="space-nav sources-nav">
          <button
            type="button"
            className={!searchOpen && (imported || sourceOpen) ? "active" : ""}
            onClick={() => showSources()}
          >
            <i className="space-dot green" /> <span>Sources</span>
            <b>{imports.length}</b>
          </button>
        </nav>
        {imports.length > 0 && (
          <>
            <p className="section-label spaces-label">Imported</p>
            <nav className="imported-nav">
              {imports.map((item) => (
                <button
                  type="button"
                  className={imported?.id === item.id ? "active" : ""}
                  key={item.id}
                  onClick={() => void openImported(item.sourceId, item.path)}
                >
                  <span>
                    {item.title} · {item.sourceId === "shared" ? "S3" : "Git"}
                  </span>
                </button>
              ))}
            </nav>
          </>
        )}
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
        {routeError
          ? (
            <section className="empty-state route-unavailable">
              <p className="eyebrow">Unavailable</p>
              <h1>Knowledge page not found</h1>
              <p>{routeError}</p>
              <button
                className="primary"
                type="button"
                onClick={() => showHome()}
              >
                Back to Home
              </button>
            </section>
          )
          : homeOpen
          ? (
            <HomePanel
              concepts={concepts}
              spaces={spaces}
              imports={imports}
              repositories={repositories}
              shared={sharedSource}
              canEdit={Boolean(bootstrap.canEdit)}
              onOpenConcept={showHubConcept}
              onOpenImported={openImported}
              onCreate={showCreate}
              onSearch={showSearch}
              onSources={showSources}
            />
          )
          : createOpen && bootstrap.canEdit
          ? (
            <HubCreatePanel
              spaces={spaces}
              busy={actionBusy}
              error={actionError}
              onCreateSpace={createSpace}
              onCreateConcept={createConcept}
              onRenameSpace={renameSpace}
              onDeleteSpace={deleteSpace}
              onCancel={() => concept ? showHubConcept(concept.id) : showHome()}
            />
          )
          : searchOpen
          ? (
            <SearchPanel
              onOpenHub={showHubConcept}
              onOpenImported={openImported}
            />
          )
          : sourceOpen
          ? (
            <div className="source-panel">
              <div className="source-page-heading">
                <p className="eyebrow">Connected knowledge</p>
                <h1>Knowledge sources</h1>
                <p>
                  {connectedSourceCount} connected · {imports.length}{" "}
                  healthy concepts
                </p>
              </div>
              {sourceError && (
                <p className="source-error" role="alert">{sourceError}</p>
              )}
              {repositories.map((repository) => (
                <RepositoryPanel
                  key={repository.id}
                  source={repository}
                  imports={imports}
                  canManage={bootstrap.access === "owner"}
                  busy={sourceBusy}
                  error=""
                  onConnect={connectRepository}
                  onRefresh={refreshRepository}
                  onDisconnect={disconnectRepository}
                  onOpen={openImported}
                />
              ))}
              {(bootstrap.access === "owner" || !repositories.length) && (
                <RepositoryPanel
                  source={null}
                  imports={imports}
                  canManage={bootstrap.access === "owner"}
                  busy={sourceBusy}
                  error=""
                  onConnect={connectRepository}
                  onRefresh={refreshRepository}
                  onDisconnect={disconnectRepository}
                  onOpen={openImported}
                />
              )}
              <SharedStorePanel
                source={sharedSource}
                imports={imports}
                canManage={bootstrap.access === "owner"}
                busy={sharedBusy}
                error={sharedError}
                onConnect={connectSharedSource}
                onRefresh={refreshSharedSource}
                onOpen={openImported}
              />
              {bootstrap.access === "owner" && <AutomationPanel />}
            </div>
          )
          : imported?.markdown
          ? (
            <MilkdownProvider key={`imported-${imported.path}`}>
              <div className="workspace-bar imported-bar">
                <div>
                  <strong>{imported.type}</strong>
                  <span>{imported.path}</span>
                </div>
                <span className="access-badge">Read only</span>
                <button
                  type="button"
                  onClick={() => showSources()}
                >
                  Source details
                </button>
              </div>
              <section className="import-provenance">
                <span>{importedSourceLabel}</span>
                <span>
                  Revision <code>{imported.sourceRevision.slice(0, 12)}</code>
                </span>
                <span>{imported.revisionCount} imported revisions</span>
                <span>
                  Synced {new Date(imported.importedAt).toLocaleString()}
                </span>
              </section>
              <div className="editor-frame read-only">
                <div className="editor-context">
                  <span className="published-label">
                    {imported.sourceId === "shared"
                      ? "SHARED STORE"
                      : "REPOSITORY"} · READ ONLY
                  </span>
                  <span>The connected source is authoritative</span>
                </div>
                <DocumentPreview markdown={imported.markdown} />
              </div>
            </MilkdownProvider>
          )
          : !conceptLoaded
          ? <div className="editor-loading">Opening authorised concept…</div>
          : !concept
          ? (
            <section className="empty-state">
              <p className="eyebrow">Hub-native knowledge</p>
              <h1>No published knowledge yet</h1>
              <p>
                {bootstrap.canEdit
                  ? "Create the first document and start writing visually."
                  : "An editor has not published a document yet."}
              </p>
              {bootstrap.canEdit && (
                <button
                  className="primary"
                  type="button"
                  disabled={actionBusy}
                  onClick={() => setCreateOpen(true)}
                >
                  Create document
                </button>
              )}
              {actionError && <p className="form-error">{actionError}</p>}
            </section>
          )
          : (
            <MilkdownProvider
              key={`${concept.id}-${concept.status}-${view}-${editorVersion}`}
            >
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
                {concept.publishedRevision && (
                  <a
                    className="export-link"
                    href={`${SERVICE}${conceptPath(concept.id)}/export`}
                  >
                    Download OKF
                  </a>
                )}
                {bootstrap.canEdit && (
                  <div className="lifecycle-actions">
                    {concept.status === "active" && (
                      <div className="view-switch" aria-label="Concept view">
                        <button
                          type="button"
                          className={view === "draft" ? "active" : ""}
                          onClick={() =>
                            setView("draft")}
                        >
                          Draft
                        </button>
                        <button
                          type="button"
                          className={view === "published" ? "active" : ""}
                          disabled={!concept.published}
                          onClick={() =>
                            setView("published")}
                        >
                          Published
                        </button>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setHistoryOpen(!historyOpen)}
                    >
                      History ({concept.revisions.length})
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setDocumentSettingsOpen(!documentSettingsOpen)}
                    >
                      Document settings
                    </button>
                    {concept.status === "active"
                      ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void lifecycle("archive")}
                            disabled={actionBusy}
                          >
                            Archive
                          </button>
                          <button
                            className="primary"
                            type="button"
                            onClick={() => void publish()}
                            disabled={actionBusy || view !== "draft"}
                          >
                            Publish
                          </button>
                        </>
                      )
                      : (
                        <button
                          className="primary"
                          type="button"
                          disabled={actionBusy}
                          onClick={() => void lifecycle("restore")}
                        >
                          Restore concept
                        </button>
                      )}
                  </div>
                )}
              </div>
              {documentSettingsOpen && bootstrap.canEdit && (
                <section className="document-settings">
                  <form onSubmit={(event) => void updateConcept(event)}>
                    <strong>Document settings</strong>
                    <label>
                      Title
                      <input
                        name="title"
                        maxLength={100}
                        defaultValue={concept.title}
                        required
                      />
                    </label>
                    <label>
                      Type
                      <input
                        name="type"
                        maxLength={50}
                        defaultValue={concept.type}
                        required
                      />
                    </label>
                    <label>
                      Intent
                      <select
                        name="intent"
                        defaultValue={concept.intent}
                        required
                      >
                        <option value="canonical">Maintained knowledge</option>
                        <option value="working">Working document</option>
                        <option value="evidence">Evidence</option>
                        <option value="ephemeral">Ephemeral notes</option>
                      </select>
                    </label>
                    <label>
                      Space
                      <select
                        name="spaceId"
                        defaultValue={concept.spaceId}
                        required
                      >
                        {spaces.map((space) => (
                          <option key={space.id} value={space.id}>
                            {space.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="primary"
                      type="submit"
                      disabled={actionBusy}
                    >
                      Save settings
                    </button>
                  </form>
                  <p>
                    Moving a document keeps every draft, revision, artifact, and
                    audit event.
                  </p>
                </section>
              )}
              {historyOpen && bootstrap.canEdit && (
                <section
                  className="revision-panel"
                  aria-label="Revision history"
                >
                  <strong>Published revisions</strong>
                  {concept.revisions.length
                    ? concept.revisions.map((revision) => (
                      <div key={revision.number}>
                        <span>
                          Revision {revision.number} · {new Date(
                            revision.publishedAt,
                          ).toLocaleString()}
                        </span>
                        <button
                          type="button"
                          disabled={actionBusy || concept.status === "archived"}
                          onClick={() =>
                            void restoreRevision(revision.number)}
                        >
                          Restore as draft
                        </button>
                      </div>
                    ))
                    : <p>Nothing has been published yet.</p>}
                </section>
              )}
              {actionError && (
                <p className="action-error" role="alert">{actionError}</p>
              )}
              <div
                className={`editor-frame ${
                  bootstrap.canEdit ? "" : "read-only"
                }`}
              >
                {concept.status === "archived"
                  ? (
                    <section className="lifecycle-empty">
                      <p className="eyebrow">Archived</p>
                      <h1>Incident communication is out of discovery</h1>
                      <p>
                        Its published revisions remain preserved and can be
                        restored.
                      </p>
                    </section>
                  )
                  : bootstrap.canEdit && view === "draft" && initialMarkdown
                  ? (
                    <>
                      <div className="editor-context">
                        <span className="draft-label">
                          {concept.intent.toUpperCase()} · SHARED DRAFT
                        </span>
                        <span>
                          {concept.publishedRevision
                            ? `Published revision ${concept.publishedRevision} stays live`
                            : "Not published yet"}
                        </span>
                      </div>
                      <EditorSurface
                        key={editorVersion}
                        conceptId={concept.id}
                        initialMarkdown={initialMarkdown}
                        user={user}
                        canEdit
                        onMarkdown={saveMarkdown}
                        onStatus={setStatus}
                        onCollaborators={setCollaborators}
                      />
                    </>
                  )
                  : concept.published
                  ? (
                    <>
                      <div className="editor-context">
                        <span className="published-label">
                          {concept.intent.toUpperCase()} · PUBLISHED
                        </span>
                        <span>Revision {concept.publishedRevision}</span>
                      </div>
                      <DocumentPreview
                        key={`${concept.publishedRevision}-${view}`}
                        markdown={concept.published}
                      />
                    </>
                  )
                  : (
                    <section className="lifecycle-empty">
                      <p className="eyebrow">Private draft</p>
                      <h1>Nothing has been published yet</h1>
                      <p>
                        Viewers will see this concept after an editor publishes
                        it.
                      </p>
                    </section>
                  )}
              </div>
              <ArtifactPanel
                conceptId={concept.id}
                conceptActive={concept.status === "active"}
              />
              <WorkTracePanel
                concept={concept}
                concepts={concepts}
                canEdit={Boolean(bootstrap.canEdit)}
                busy={actionBusy}
                onCreate={createWorkTrace}
                onFold={foldWorkTrace}
              />
            </MilkdownProvider>
          )}
      </section>
    </main>
  );
}

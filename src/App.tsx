import { Crepe } from "@milkdown/crepe";
import { collab, collabServiceCtx } from "@milkdown/plugin-collab";
import { Milkdown, MilkdownProvider, useEditor, useInstance } from "@milkdown/react";
import { getMarkdown, replaceAll } from "@milkdown/kit/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import {
  type Collaborator,
  type ConnectionStatus,
  DenoCollabProvider,
} from "./collab-provider.ts";

const SERVICE = globalThis.location.port === "8788" ? globalThis.location.origin : "http://127.0.0.1:8788";
const USERS: Collaborator[] = [
  { name: "Maya Chen", color: "#e76f51" },
  { name: "Alex Morgan", color: "#52796f" },
];
const PROFILE_MARKERS = ["- [x]", "| Severity", "~~", "[^owner]", "```mermaid", "$$"];

function EditorControls({ markdown }: { markdown: string }) {
  const [loading, getEditor] = useInstance();
  const input = useRef<HTMLInputElement>(null);

  const importMarkdown = async (file?: File) => {
    if (!file || loading) return;
    getEditor()?.action(replaceAll(await file.text()));
    if (input.current) input.current.value = "";
  };

  const exportMarkdown = () => {
    const content = getEditor()?.action(getMarkdown()) ?? markdown;
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown" }));
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
      <button type="button" onClick={() => input.current?.click()} disabled={loading}>Import .md</button>
      <button type="button" className="primary" onClick={exportMarkdown} disabled={loading}>Export .md</button>
    </div>
  );
}

function EditorSurface({
  initialMarkdown,
  user,
  onMarkdown,
  onStatus,
  onCollaborators,
}: {
  initialMarkdown: string;
  user: Collaborator;
  onMarkdown: (markdown: string) => void;
  onStatus: (status: ConnectionStatus) => void;
  onCollaborators: (users: Collaborator[]) => void;
}) {
  useEditor(
    (root) => {
      const doc = new Y.Doc();
      const provider = new DenoCollabProvider(
        `${SERVICE.replace("http", "ws")}/collab`,
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

      crepe.editor.use(collab);
      crepe.on((listener) => {
        listener.mounted((ctx) => {
          const service = ctx.get(collabServiceCtx).bindDoc(doc).setAwareness(provider.awareness);
          provider.onSynced(() => {
            if (editorConnected) return;
            service.applyTemplate(initialMarkdown).connect();
            editorConnected = true;
            globalThis.requestAnimationFrame(() => onMarkdown(crepe.getMarkdown()));
          });
          provider.connect();
        });
        listener.markdownUpdated((_ctx, markdown, previous) => {
          if (markdown !== previous) onMarkdown(markdown);
        });
        listener.destroy(() => provider.destroy());
      });
      return crepe;
    },
    [initialMarkdown, user.name],
  );

  return <Milkdown />;
}

export default function App() {
  const [user] = useState<Collaborator>(() => {
    const requested = new URLSearchParams(globalThis.location.search).get("user");
    return USERS.find((candidate) => candidate.name === requested) ?? USERS[0];
  });
  const [initialMarkdown, setInitialMarkdown] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "failed">("saved");
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    fetch(`${SERVICE}/api/doc`)
      .then((response) => {
        if (!response.ok) throw new Error("service unavailable");
        return response.text();
      })
      .then((content) => {
        setInitialMarkdown(content);
        setMarkdown(content);
      })
      .catch(() => setLoadError(true));
  }, [reload]);

  const saveMarkdown = useCallback((content: string) => {
    setMarkdown(content);
    setSaveState("saving");
    if (saveTimer.current) globalThis.clearTimeout(saveTimer.current);
    saveTimer.current = globalThis.setTimeout(() => {
      fetch(`${SERVICE}/api/doc`, { method: "PUT", body: content })
        .then((response) => {
          if (!response.ok) throw new Error("save failed");
          setSaveState("saved");
        })
        .catch(() => setSaveState("failed"));
    }, 300);
  }, []);

  const openCollaborator = () => {
    const other = USERS.find((candidate) => candidate.name !== user.name) ?? USERS[1];
    const url = new URL(globalThis.location.href);
    url.searchParams.set("user", other.name);
    globalThis.open(url, "_blank", "noopener");
  };

  const profileCoverage = PROFILE_MARKERS.filter((marker) => markdown.includes(marker)).length;

  return (
    <main className="app-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="OKF Hub home"><span>O</span> OKF Hub</a>
        <div className="document-title"><small>Policies /</small><strong>Incident communication</strong></div>
        <div className="header-status">
          <span className={`connection ${status}`}><i />{status}</span>
          <span className="save-state">{saveState === "saved" ? "Saved as Markdown" : saveState}</span>
        </div>
      </header>

      <aside className="sidebar">
        <p className="section-label">Company knowledge</p>
        <nav>
          <button type="button">⌕ <span>Search</span></button>
          <button type="button">⌂ <span>Home</span></button>
        </nav>
        <p className="section-label spaces-label">Spaces</p>
        <nav>
          <button type="button" className="active"><i className="space-dot coral" /> <span>Policies</span><b>4</b></button>
          <button type="button"><i className="space-dot green" /> <span>Engineering</span><b>31</b></button>
          <button type="button"><i className="space-dot gold" /> <span>Operations</span><b>16</b></button>
        </nav>
        <div className="sidebar-bottom">
          <p className="section-label">Prototype coverage</p>
          <div className="coverage"><strong>{profileCoverage}/{PROFILE_MARKERS.length}</strong><span>extended profile markers intact</span></div>
          <small>CommonMark · GFM · footnotes · math · Mermaid</small>
        </div>
      </aside>

      <section className="workspace">
        <MilkdownProvider>
          <div className="workspace-bar">
            <div className="people" aria-label={`${collaborators.length} collaborators online`}>
              {collaborators.map((person) => <span key={person.name} style={{ background: person.color }} title={person.name}>{person.name.split(" ").map((part) => part[0]).join("")}</span>)}
              <small>{collaborators.length} online</small>
            </div>
            <button type="button" className="collaborator-button" onClick={openCollaborator}>Open collaborator ↗</button>
            <EditorControls markdown={markdown} />
          </div>

          <div className="editor-frame">
            {loadError ? (
              <div className="service-error" role="alert">
                <span>Service offline</span>
                <h1>Start the local collaboration service</h1>
                <p>The editor waits for the Deno service so it can restore the shared document safely.</p>
                <button type="button" onClick={() => { setLoadError(false); setInitialMarkdown(null); setReload((value) => value + 1); }}>Retry connection</button>
              </div>
            ) : initialMarkdown ? (
              <>
                <div className="editor-context">
                  <span className="draft-label">POLICY · SHARED DRAFT</span>
                  <span>Editing as <strong>{user.name}</strong></span>
                </div>
                <EditorSurface
                  initialMarkdown={initialMarkdown}
                  user={user}
                  onMarkdown={saveMarkdown}
                  onStatus={setStatus}
                  onCollaborators={setCollaborators}
                />
              </>
            ) : (
              <div className="editor-loading">Opening canonical Markdown…</div>
            )}
          </div>
        </MilkdownProvider>
      </section>
    </main>
  );
}

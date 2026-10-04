import { MilkdownProvider } from "@milkdown/react";
import {
  FolderOpen,
  GitBranch,
  Lock,
  MessageSquare,
  Presentation,
  Sparkles,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppSidebar } from "./components/app-sidebar.tsx";
import { AskOKF, type AskSession } from "./components/ask-okf.tsx";
import { CommandPalette } from "./components/command-palette.tsx";
import { DeveloperApiDocumentation } from "./components/developer-panel.tsx";
import {
  AccessGate,
  AuthScreen,
  WorkspaceOnboarding,
} from "./components/auth-panels.tsx";
import {
  DocumentEditor,
  DocumentPreview,
} from "./components/editor/document-editor.tsx";
import {
  type CommentAnchor,
  type CommentSelection,
  DocumentComments,
} from "./components/editor/document-comments.tsx";
import { deriveFreshness } from "./lib/governance.ts";
import { DocumentGovernance } from "./components/editor/document-governance.tsx";
import { DocumentProperties } from "./components/editor/document-properties.tsx";
import { DocumentReferences } from "./components/editor/document-references.tsx";
import { PresentationMode } from "./components/editor/presentation-mode.tsx";
import { RevisionHistory } from "./components/editor/revision-history.tsx";
import { DraftReview } from "./components/editor/draft-review.tsx";
import { DraftSaveQueue, type SaveState } from "./lib/draft-save.ts";
import {
  type DocumentMode,
  type DocumentSurface,
  DocumentToolbar,
  type DocumentWidth,
} from "./components/editor/document-toolbar.tsx";
import { HomePanel } from "./components/home-panel.tsx";
import { SpacePanel } from "./components/space-panel.tsx";
import { SpaceIconPicker } from "./components/space-icon-picker.tsx";
import { AppPanel, SourceWorkspace } from "./components/source-panels.tsx";
import { WorkspaceHeader } from "./components/workspace-header.tsx";
import { SearchPanel, WorkTracePanel } from "./components/workspace-panels.tsx";
import {
  NewDocumentDialog,
  type TemplateDraftCache,
  WorkspaceSettings,
} from "./components/workspace-settings.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Label } from "./components/ui/label.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import { SidebarInset, SidebarProvider } from "./components/ui/sidebar.tsx";
import { type Collaborator, type ConnectionStatus } from "./collab-provider.ts";
import { api, conceptPath, SERVICE } from "./lib/api.ts";
import { enableEmbedConnectors } from "./lib/embeds.ts";
import type { ConnectorDefinition } from "./lib/connectors.ts";
import type {
  AIConfig,
  Artifact,
  Bootstrap,
  Concept,
  DocumentTemplate,
  ImportedConcept,
  NotionSource,
  RepositorySource,
  SharedSource,
  Sources,
  Space,
  WorkTrace,
} from "./lib/models.ts";
import {
  type AppRoute,
  parseAppRoute,
  resolveImportedLink,
  routePath,
  type SettingsSection,
} from "./routes.ts";

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
export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [fatal, setFatal] = useState("");
  const [concept, setConcept] = useState<Concept | null>(null);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [conceptLoaded, setConceptLoaded] = useState(false);
  const [hubReady, setHubReady] = useState(false);
  const [sourcesReady, setSourcesReady] = useState(false);
  const [routeError, setRouteError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [newDocumentSpaceId, setNewDocumentSpaceId] = useState<string>();
  const [newDocumentParentId, setNewDocumentParentId] = useState<string>();
  const [spaceDialogOpen, setSpaceDialogOpen] = useState(false);
  const [spaceDialogIcon, setSpaceDialogIcon] = useState("");
  const [documentSettingsOpen, setDocumentSettingsOpen] = useState(false);
  const [initialMarkdown, setInitialMarkdown] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [draftSavedAt, setDraftSavedAt] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [newDocumentTemplateId, setNewDocumentTemplateId] = useState<string>();
  const [templateSnapshot, setTemplateSnapshot] = useState<
    { title: string; body: string } | null
  >(null);
  const [templateSaved, setTemplateSaved] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(
    "general",
  );
  const [view, setView] = useState<"draft" | "published">("draft");
  const [surface, setSurface] = useState<DocumentSurface>("document");
  const [documentMode, setDocumentMode] = useState<DocumentMode>("edit");
  const [documentWidth, setDocumentWidth] = useState<DocumentWidth>("standard");
  const [focusMode, setFocusMode] = useState(false);
  const [referencesOpen, setReferencesOpen] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentAnchor, setCommentAnchor] = useState<CommentAnchor>(null);
  const [commentSelection, setCommentSelection] = useState<CommentSelection>(
    null,
  );
  const [activeCommentThreadId, setActiveCommentThreadId] = useState<
    string | null
  >(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [aiConfig, setAIConfig] = useState<AIConfig>({
    enabled: false,
    provider: "",
    model: "",
  });
  const [actionError, setActionError] = useState("");
  const [editorVersion, setEditorVersion] = useState(0);
  const [repositories, setRepositories] = useState<RepositorySource[]>([]);
  const [sharedSource, setSharedSource] = useState<SharedSource | null>(null);
  const [notionSource, setNotionSource] = useState<NotionSource | null>(null);
  const [connectors, setConnectors] = useState<ConnectorDefinition[]>([]);
  const [imports, setImports] = useState<ImportedConcept[]>([]);
  const [imported, setImported] = useState<ImportedConcept | null>(null);
  const [homeOpen, setHomeOpen] = useState(false);
  const [spaceIdOpen, setSpaceIdOpen] = useState<string | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [developerOpen, setDeveloperOpen] = useState(false);
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sharedBusy, setSharedBusy] = useState(false);
  const [notionBusy, setNotionBusy] = useState(false);
  const [sourceScheduleBusyId, setSourceScheduleBusyId] = useState<
    string | null
  >(null);
  const [sourceError, setSourceError] = useState("");
  const [sharedError, setSharedError] = useState("");
  const [notionError, setNotionError] = useState("");
  const latestMarkdown = useRef(markdown);
  latestMarkdown.current = markdown;
  const documentSnapshot = useRef<(() => string | null) | null>(null);
  const handleDraftSnapshot = useCallback(
    (read: (() => string | null) | null) => {
      documentSnapshot.current = read;
    },
    [],
  );
  const activeConceptId = useRef<string | null>(null);
  const latestConcept = useRef(concept);
  latestConcept.current = concept;
  const navigationVersion = useRef(0);
  const lastRoutePath = useRef(
    globalThis.location.pathname + globalThis.location.search,
  );
  const recordRoute = (
    route: Exclude<AppRoute, { kind: "not_found" }>,
    replace = false,
  ) => {
    lastRoutePath.current = routePath(route);
    setBrowserRoute(route, replace);
  };
  const metadataFlush = useRef<(() => Promise<void>) | null>(null);
  const governanceFlush = useRef<(() => Promise<void>) | null>(null);
  const handleGovernanceSaveReady = useCallback(
    (flush: (() => Promise<void>) | null) => {
      governanceFlush.current = flush;
    },
    [],
  );
  const handleGovernanceUpdate = useCallback((updated: Concept) => {
    const governance = {
      ownerUserId: updated.ownerUserId,
      owner: updated.owner,
      reviewDueDate: updated.reviewDueDate,
      reviewedRevision: updated.reviewedRevision,
      reviewedAt: updated.reviewedAt,
      reviewedBy: updated.reviewedBy,
      reviewer: updated.reviewer,
    };
    const merge = (current: Concept) => {
      const next = { ...current, ...governance };
      return { ...next, freshness: deriveFreshness(next) };
    };
    if (latestConcept.current?.id === updated.id) {
      latestConcept.current = merge(latestConcept.current);
    }
    setConcept((current) =>
      current?.id === updated.id ? merge(current) : current
    );
    setConcepts((current) =>
      current.map((item) => item.id === updated.id ? merge(item) : item)
    );
  }, []);
  const askSessions = useRef(new Map<string, AskSession>());
  const templateDraftCache = useRef<TemplateDraftCache>(new Map());
  const [saveQueue] = useState(() =>
    new DraftSaveQueue(async (id, content) => {
      const response = await api(conceptPath(id), {
        method: "PUT",
        body: content,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          ...(latestConcept.current?.id === id
            ? {
              "x-okf-collab-epoch": String(latestConcept.current.collabEpoch),
            }
            : {}),
        },
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as {
          error?: string;
        };
        throw new Error(result.error ?? "Could not save draft");
      }
      const changed =
        response.headers.get("x-okf-unpublished-changes") === "true";
      setConcept((current) =>
        current?.id === id
          ? { ...current, hasUnpublishedChanges: changed }
          : current
      );
      setConcepts((current) =>
        current.map((item) =>
          item.id === id ? { ...item, hasUnpublishedChanges: changed } : item
        )
      );
    }, (id, state) => {
      if (activeConceptId.current === id) {
        setSaveState(state);
        if (state === "saved") setDraftSavedAt(new Date().toISOString());
      }
    })
  );

  const finishDraft = useCallback(async () => {
    try {
      await metadataFlush.current?.();
      await governanceFlush.current?.();
      const content = documentSnapshot.current?.();
      const id = activeConceptId.current;
      if (id && content != null && content !== latestMarkdown.current) {
        latestMarkdown.current = content;
        setMarkdown(content);
        saveQueue.stage(id, content);
      }
      if (!await saveQueue.flush(id)) {
        throw new Error(
          saveQueue.error(id) ??
            "Your changes could not be saved. Retry saving before leaving this document.",
        );
      }
      setActionError("");
      return true;
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "Your changes could not be saved.",
      );
      return false;
    }
  }, [saveQueue]);

  useEffect(() => {
    const protectDraft = (event: BeforeUnloadEvent) => {
      const content = documentSnapshot.current?.();
      const unstaged = content != null && content !== latestMarkdown.current;
      if (
        !unstaged && !saveQueue.hasPending() && !templateDraftCache.current.size
      ) return;
      event.preventDefault();
      event.returnValue = "";
    };
    globalThis.addEventListener("beforeunload", protectDraft);
    return () => globalThis.removeEventListener("beforeunload", protectDraft);
  }, [saveQueue]);

  const referenceInserter = useRef<
    ((title: string, href: string) => void) | null
  >(null);
  const pendingReference = useRef<{ title: string; href: string } | null>(null);
  const commentReader = useRef<
    (() => NonNullable<CommentAnchor> | null) | null
  >(null);

  useEffect(() => {
    if (!commentSelection) return;
    const clear = () => setCommentSelection(null);
    globalThis.addEventListener("scroll", clear, true);
    globalThis.addEventListener("resize", clear);
    return () => {
      globalThis.removeEventListener("scroll", clear, true);
      globalThis.removeEventListener("resize", clear);
    };
  }, [commentSelection]);

  const refresh = useCallback(async () => {
    const response = await api("/api/bootstrap");
    const result = await response.json() as Bootstrap & { error?: string };
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
    setNotionSource(sources.notion);
    setConnectors(sources.connectors);
    enableEmbedConnectors(
      sources.connectors.filter((connector) => connector.enabled).map((
        connector,
      ) => connector.id),
    );
    setImports(await importsResponse.json());
  }, []);
  const loadTemplates = useCallback(async () => {
    const response = await api("/api/templates");
    const result = await response.json() as DocumentTemplate[] & {
      error?: string;
    };
    if (!response.ok) throw new Error(result.error ?? "Templates unavailable");
    setTemplates(result);
  }, []);
  const loadAIConfig = useCallback(async () => {
    const response = await api("/api/ai/config");
    const result = await response.json() as AIConfig & { error?: string };
    if (!response.ok) {
      throw new Error(result.error ?? "AI settings unavailable");
    }
    setAIConfig(result);
  }, []);
  const openHubConcept = useCallback(async (id: string, record = true) => {
    const requestVersion = ++navigationVersion.current;
    if (!await finishDraft()) return false;
    if (requestVersion !== navigationVersion.current) return false;
    setConceptLoaded(false);
    setRouteError("");
    const response = await api(conceptPath(id));
    const result = await response.json() as Concept & { error?: string };
    if (requestVersion !== navigationVersion.current) return false;
    if (!response.ok) {
      setConceptLoaded(true);
      throw new Error(result.error ?? "Concept unavailable");
    }
    activeConceptId.current = id;
    setDraftSavedAt(result.updatedAt);
    setSaveState(saveQueue.state(id));
    setReviewOpen(false);
    setConcept(result);
    const content = bootstrap?.canEdit ? result.draft : result.published;
    if (bootstrap?.canEdit) saveQueue.accept(id, content ?? "");
    setInitialMarkdown(content ?? null);
    setMarkdown(content ?? "");
    setView(bootstrap?.canEdit ? "draft" : "published");
    setEditorVersion((current) => current + 1);
    setConceptLoaded(true);
    setCreateOpen(false);
    setDocumentSettingsOpen(false);
    setCommentsOpen(false);
    setCommentAnchor(null);
    setImported(null);
    setHomeOpen(false);
    setSpaceIdOpen(null);
    setSourceOpen(false);
    setSearchOpen(false);
    setDeveloperOpen(false);
    setPresenting(false);
    const requestedSurface = !record
      ? new URLSearchParams(globalThis.location.search).get("surface")
      : null;
    setSurface(
      requestedSurface === "artifacts" || requestedSurface === "activity"
        ? requestedSurface
        : "document",
    );
    if (record) recordRoute({ kind: "concept", id });
    else {lastRoutePath.current = globalThis.location.pathname +
        globalThis.location.search;}
    return true;
  }, [bootstrap?.canEdit, finishDraft, saveQueue]);
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
  useEffect(() => {
    if (!bootstrap?.canView) return;
    void loadAIConfig().catch((error) => setActionError(error.message));
  }, [bootstrap?.canView, loadAIConfig]);
  useEffect(() => {
    if (!bootstrap?.canEdit) return;
    void loadTemplates().catch((error) => setActionError(error.message));
  }, [bootstrap?.canEdit, loadTemplates]);

  const signOut = async () => {
    if (!await finishDraft() || !await saveQueue.flushAll()) return;
    try {
      const response = await api("/api/auth/sign-out", { method: "POST" });
      if (!response.ok) {
        throw new Error("Could not sign out. Please try again.");
      }
      navigationVersion.current++;
      saveQueue.clear();
      askSessions.current.clear();
      templateDraftCache.current.clear();
      activeConceptId.current = null;
      setTemplateSnapshot(null);
      setBootstrap({ user: null });
      setConcept(null);
      setConcepts([]);
      setTemplates([]);
      setSpaces([]);
      setConceptLoaded(false);
      setHubReady(false);
      setSourcesReady(false);
      setRouteError("");
      setInitialMarkdown(null);
      setRepositories([]);
      setSharedSource(null);
      setNotionSource(null);
      setConnectors([]);
      enableEmbedConnectors([]);
      setImports([]);
      setImported(null);
      setHomeOpen(false);
      setSpaceIdOpen(null);
      setSearchOpen(false);
      setAskOpen(false);
      setAIConfig({ enabled: false, provider: "", model: "" });
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "Could not sign out. Please try again.",
      );
    }
  };
  const saveMarkdown = useCallback((content: string) => {
    if (!bootstrap?.canEdit || !concept || concept.lockedAt) return;
    latestMarkdown.current = content;
    setMarkdown(content);
    const changed = !concept.publishedRevision ||
      content.trimEnd() !== (concept.published ?? "").trimEnd();
    setConcepts((current) =>
      current.map((item) =>
        item.id === concept.id
          ? {
            ...item,
            hasUnpublishedChanges: changed,
            updatedAt: new Date().toISOString(),
          }
          : item
      )
    );
    saveQueue.stage(concept.id, content);
  }, [bootstrap?.canEdit, concept, saveQueue]);

  const lifecycle = async (path: string, body?: unknown) => {
    if (!concept) return null;
    setActionBusy(true);
    setActionError("");
    try {
      if (!await finishDraft()) return null;
      const response = await api(`${conceptPath(concept.id)}/${path}`, {
        method: "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json() as Concept & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Action failed");
      saveQueue.accept(result.id, result.draft ?? "");
      setConcept(result);
      await refreshHubLists().catch(() => {});
      return result;
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "Action failed. Please try again.",
      );
      return null;
    } finally {
      setActionBusy(false);
    }
  };
  const documentLifecycle = async (id: string, action: string) => {
    setActionBusy(true);
    try {
      if (id === activeConceptId.current && !await finishDraft()) return;
      setActionError("");
      const response = await api(`${conceptPath(id)}/${action}`, {
        method: "POST",
      });
      const result = await response.json().catch(() => ({})) as Concept & {
        error?: string;
      };
      if (!response.ok) {
        setActionError(result.error ?? "Document action failed");
        return;
      }
      if (concept?.id === id) {
        saveQueue.accept(result.id, result.draft ?? "");
        setConcept(result);
        setInitialMarkdown(result.draft ?? null);
        setMarkdown(result.draft ?? "");
        setEditorVersion((current) => current + 1);
      }
      await refreshHubLists();
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "The action failed. Please try again.",
      );
    } finally {
      setActionBusy(false);
    }
  };

  const createSpace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const name = String(fields.get("name") ?? "");
    const icon = String(fields.get("icon") ?? "");
    setActionBusy(true);
    try {
      setActionError("");
      const response = await api("/api/spaces", {
        method: "POST",
        body: JSON.stringify({ name, icon }),
      });
      const result = await response.json() as Space & { error?: string };
      if (!response.ok) {
        setActionError(result.error ?? "Creation failed");
        return false;
      }
      form.reset();
      await refreshHubLists();
      return true;
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "The action failed. Please try again.",
      );
      return false;
    } finally {
      setActionBusy(false);
    }
  };
  const updateWorkspace = async (value: {
    name: string;
    tagline: string;
    logo: string;
  }) => {
    setActionBusy(true);
    try {
      setActionError("");
      const response = await api("/api/workspace", {
        method: "PUT",
        body: JSON.stringify(value),
      });
      const result = await response.json() as Bootstrap & { error?: string };
      if (!response.ok) {
        setActionError(result.error ?? "Workspace update failed");
        return false;
      }
      setBootstrap(result);
      return true;
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "The action failed. Please try again.",
      );
      return false;
    } finally {
      setActionBusy(false);
    }
  };

  const renameSpace = async (
    event: FormEvent<HTMLFormElement>,
    space: Space,
  ) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const name = String(fields.get("name") ?? "");
    const icon = String(fields.get("icon") ?? "");
    setActionBusy(true);
    try {
      setActionError("");
      const response = await api(`/api/spaces/${space.id}`, {
        method: "PUT",
        body: JSON.stringify({ name, icon }),
      });
      const result = await response.json() as Space & { error?: string };
      if (!response.ok) return setActionError(result.error ?? "Rename failed");
      if (concept?.spaceId === space.id) {
        setConcept({ ...concept, space: result.name });
      }
      await refreshHubLists();
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "The action failed. Please try again.",
      );
    } finally {
      setActionBusy(false);
    }
  };

  const deleteSpace = async (space: Space) => {
    setActionBusy(true);
    try {
      setActionError("");
      const response = await api(`/api/spaces/${space.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as {
          error?: string;
        };
        return setActionError(result.error ?? "Deletion failed");
      }
      await refreshHubLists();
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "The action failed. Please try again.",
      );
    } finally {
      setActionBusy(false);
    }
  };

  const createTemplate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (actionBusy) return false;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setActionBusy(true);
    try {
      setActionError("");
      const response = await api("/api/templates", {
        method: "POST",
        body: JSON.stringify({
          name: fields.get("name"),
          description: fields.get("description"),
          body: fields.get("body"),
        }),
      });
      const result = await response.json() as DocumentTemplate & {
        error?: string;
      };
      if (!response.ok) {
        setActionError(result.error ?? "Template creation failed");
        return false;
      }
      setTemplates((
        current,
      ) => [...current.filter((item) => item.id !== result.id), result]);
      form.reset();
      return true;
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "The action failed. Please try again.",
      );
      return false;
    } finally {
      setActionBusy(false);
    }
  };

  const updateTemplate = async (
    id: string,
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (actionBusy) return false;
    const fields = new FormData(event.currentTarget);
    setActionBusy(true);
    setActionError("");
    try {
      const response = await api(`/api/templates/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({
          name: fields.get("name"),
          description: fields.get("description"),
          body: fields.get("body"),
        }),
      });
      const result = await response.json() as DocumentTemplate & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(result.error ?? "Template update failed");
      }
      setTemplates((current) =>
        current.map((item) => item.id === result.id ? result : item)
      );
      return true;
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "Template update failed",
      );
      return false;
    } finally {
      setActionBusy(false);
    }
  };

  const deleteTemplate = async (item: DocumentTemplate) => {
    setActionBusy(true);
    try {
      setActionError("");
      const response = await api(
        `/api/templates/${encodeURIComponent(item.id)}`,
        {
          method: "DELETE",
        },
      );
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as {
          error?: string;
        };
        return setActionError(result.error ?? "Template deletion failed");
      }
      setTemplates((current) =>
        current.filter((template) => template.id !== item.id)
      );
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "The action failed. Please try again.",
      );
    } finally {
      setActionBusy(false);
    }
  };

  const createConcept = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setActionBusy(true);
    try {
      setActionError("");
      const templateId = String(fields.get("templateId") ?? "");
      const variables = Object.fromEntries(
        Array.from(fields.entries())
          .filter(([name]) => name.startsWith("variable:"))
          .map((
            [name, value],
          ) => [name.slice("variable:".length), String(value)]),
      );
      const response = await api("/api/concepts", {
        method: "POST",
        body: JSON.stringify({
          title: fields.get("title"),
          type: fields.get("type"),
          intent: fields.get("intent"),
          spaceId: fields.get("spaceId"),
          parentId: fields.get("parentId") || null,
          ...(templateId ? { templateId, variables } : {}),
        }),
      });
      const result = await response.json() as Concept & { error?: string };
      if (!response.ok) {
        setActionError(result.error ?? "Creation failed");
        return false;
      }
      await refreshHubLists();
      await openHubConcept(result.id);
      return true;
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "The action failed. Please try again.",
      );
      return false;
    } finally {
      setActionBusy(false);
    }
  };

  const updateConcept = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!concept) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setActionBusy(true);
    try {
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
      if (!response.ok) return setActionError(result.error ?? "Update failed");
      setConcept(result);
      setDocumentSettingsOpen(false);
      await refreshHubLists();
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "The action failed. Please try again.",
      );
    } finally {
      setActionBusy(false);
    }
  };

  const publish = async () => {
    const result = await lifecycle("publish");
    if (result) {
      setSaveState("saved");
      setMarkdown(result.draft ?? "");
      setView("published");
      setReviewOpen(false);
    }
  };

  const moveDocument = async (
    item: Concept,
    destination: { spaceId: string; parentId: string | null; index: number },
  ) => {
    setActionError("");
    const response = await api(`${conceptPath(item.id)}/move`, {
      method: "POST",
      body: JSON.stringify(destination),
    });
    const result = await response.json() as Concept & { error?: string };
    if (!response.ok) {
      return setActionError(result.error ?? "Move failed");
    }
    if (concept?.id === result.id) setConcept(result);
    await refreshHubLists();
  };

  const restoreRevision = async (number: number) => {
    const result = await lifecycle(`revisions/${number}/restore`);
    if (result?.draft == null) return;
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
    try {
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
      if (!response.ok) {
        return setActionError(result.error ?? "Work trace failed");
      }
      setConcept(result);
      form.reset();
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "The action failed. Please try again.",
      );
    } finally {
      setActionBusy(false);
    }
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
    try {
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
      if (!response.ok) return setActionError(result.error ?? "Fold failed");
      setConcept(result);
      if (targetConceptId === concept.id && result.draft) {
        setInitialMarkdown(result.draft);
        setMarkdown(result.draft);
        setEditorVersion((current) => current + 1);
      }
      await refreshHubLists();
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "The action failed. Please try again.",
      );
    } finally {
      setActionBusy(false);
    }
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

  const connectGitHubRepository = async (
    installationId: number,
    repositoryId: number,
    folder: string,
  ) => {
    setSourceBusy(true);
    setSourceError("");
    const response = await api("/api/sources/github", {
      method: "POST",
      body: JSON.stringify({ installationId, repositoryId, folder }),
    });
    const result = await response.json() as RepositorySource & {
      error?: string;
    };
    setSourceBusy(false);
    if (!response.ok) {
      setSourceError(result.error ?? "GitHub connection failed");
      return;
    }
    globalThis.history.replaceState({}, "", "/sources");
    await loadSources().catch(() => {});
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

  const connectNotionSource = async (token: string) => {
    setNotionBusy(true);
    setNotionError("");
    const response = await api("/api/sources/notion", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    const result = await response.json() as NotionSource & { error?: string };
    setNotionBusy(false);
    if (result?.id === "notion") setNotionSource(result);
    if (!response.ok) {
      setNotionError(result.error ?? "Notion connection failed");
    }
    await loadSources().catch(() => {});
  };

  const connectConnector = async (
    connector: ConnectorDefinition,
    values: Record<string, string>,
  ) => {
    setSourceBusy(true);
    setSourceError("");
    const response = await api(`/api/connectors/${connector.id}/connect`, {
      method: "POST",
      body: JSON.stringify(values),
    });
    const result = await response.json() as { error?: string };
    setSourceBusy(false);
    if (!response.ok) setSourceError(result.error ?? "Connection failed");
    await loadSources().catch(() => {});
  };

  const setConnectorEnabled = async (id: string, enabled: boolean) => {
    const response = await api(`/api/connectors/${id}/enabled`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    });
    const result = await response.json() as ConnectorDefinition & {
      error?: string;
    };
    if (!response.ok) {
      setSourceError(result.error ?? "Connector update failed");
      return;
    }
    await loadSources();
  };

  const refreshNotionSource = async () => {
    setNotionBusy(true);
    setNotionError("");
    const response = await api("/api/sources/notion/refresh", {
      method: "POST",
    });
    const result = await response.json() as NotionSource & { error?: string };
    setNotionBusy(false);
    if (result?.id === "notion") setNotionSource(result);
    if (!response.ok) setNotionError(result.error ?? "Notion refresh failed");
    await loadSources().catch(() => {});
  };

  const updateSourceSchedule = async (
    sourceId: string,
    intervalMinutes: number,
  ) => {
    setSourceScheduleBusyId(sourceId);
    setSourceError("");
    const response = await api(`/api/sources/${sourceId}/schedule`, {
      method: "PUT",
      body: JSON.stringify({ intervalMinutes }),
    });
    const result = await response.json() as
      | RepositorySource
      | SharedSource
      | NotionSource
      | { error?: string };
    setSourceScheduleBusyId(null);
    if (!response.ok) {
      setSourceError(
        "error" in result && result.error
          ? result.error
          : "Schedule update failed",
      );
      return;
    }
    if (sourceId === "shared") {
      setSharedSource(result as SharedSource);
    } else if (sourceId === "notion") {
      setNotionSource(result as NotionSource);
    } else {
      setRepositories((current) =>
        current.map((source) =>
          source.id === sourceId ? result as RepositorySource : source
        )
      );
    }
  };

  const openImported = async (
    sourceId: string,
    path: string,
    record = true,
  ) => {
    const requestVersion = ++navigationVersion.current;
    if (!await finishDraft()) return false;
    if (requestVersion !== navigationVersion.current) return null;
    setSourceError("");
    setRouteError("");
    try {
      const response = await api(
        `/api/imported?source=${sourceId}&path=${encodeURIComponent(path)}`,
      );
      const result = await response.json() as ImportedConcept & {
        error?: string;
      };
      if (requestVersion !== navigationVersion.current) return null;
      if (!response.ok) {
        setSourceError(result.error ?? "Import unavailable");
        return false;
      }
      setImported(result);
      setHomeOpen(false);
      setSpaceIdOpen(null);
      setSourceOpen(false);
      setSearchOpen(false);
      setDeveloperOpen(false);
      setPresenting(false);
      if (record) recordRoute({ kind: "imported", sourceId, path });
      return true;
    } catch (cause) {
      if (requestVersion !== navigationVersion.current) return null;
      setSourceError(
        cause instanceof Error ? cause.message : "Import unavailable",
      );
      return false;
    }
  };

  const showHubConcept = async (id?: string, record = true) => {
    if (id && id !== concept?.id) {
      try {
        await openHubConcept(id, record);
      } catch (error) {
        setConceptLoaded(true);
        setActionError(
          error instanceof Error ? error.message : "Document unavailable",
        );
      }
      return;
    }
    if (!await finishDraft()) return;
    navigationVersion.current++;
    setRouteError("");
    setImported(null);
    setHomeOpen(false);
    setSpaceIdOpen(null);
    setSourceOpen(false);
    setSearchOpen(false);
    setCreateOpen(false);
    setDeveloperOpen(false);
    setDocumentSettingsOpen(false);
    if (id && record) {
      recordRoute({ kind: "concept", id });
    } else if (!id && concept) {
      if (record) recordRoute({ kind: "concept", id: concept.id });
    } else if (!id) {
      setHomeOpen(true);
      if (record) recordRoute({ kind: "home" });
    }
  };
  const showHome = async (record = true) => {
    if (!await finishDraft()) return;
    navigationVersion.current++;
    setConceptLoaded(true);
    setPresenting(false);
    setRouteError("");
    setHomeOpen(true);
    setSpaceIdOpen(null);
    setImported(null);
    setSourceOpen(false);
    setSearchOpen(false);
    setCreateOpen(false);
    setDeveloperOpen(false);
    setDocumentSettingsOpen(false);
    if (record) recordRoute({ kind: "home" });
  };
  const showSpace = async (id: string, record = true) => {
    if (!await finishDraft()) return;
    navigationVersion.current++;
    setConceptLoaded(true);
    setPresenting(false);
    setRouteError("");
    setSpaceIdOpen(id);
    setHomeOpen(false);
    setImported(null);
    setSourceOpen(false);
    setSearchOpen(false);
    setCreateOpen(false);
    setDeveloperOpen(false);
    setDocumentSettingsOpen(false);
    if (record) recordRoute({ kind: "space", id });
  };
  const showSearch = async (record = true) => {
    if (!await finishDraft()) return;
    navigationVersion.current++;
    setConceptLoaded(true);
    setPresenting(false);
    setRouteError("");
    setHomeOpen(false);
    setSpaceIdOpen(null);
    setSearchOpen(true);
    setSourceOpen(false);
    setImported(null);
    setCreateOpen(false);
    setDeveloperOpen(false);
    if (record) recordRoute({ kind: "search" });
  };
  const openGlobalSearch = () => setSearchPaletteOpen(true);
  const showSources = async (record = true) => {
    if (!await finishDraft()) return;
    navigationVersion.current++;
    setConceptLoaded(true);
    setPresenting(false);
    setRouteError("");
    setHomeOpen(false);
    setSpaceIdOpen(null);
    setImported(null);
    setSourceOpen(true);
    setSearchOpen(false);
    setCreateOpen(false);
    setDeveloperOpen(false);
    if (record) recordRoute({ kind: "sources" });
  };
  const showCreate = async (
    section: SettingsSection = "general",
    record = true,
  ) => {
    if (!await finishDraft()) return;
    navigationVersion.current++;
    setConceptLoaded(true);
    if (section === "members" && bootstrap?.access !== "owner") {
      section = "general";
    }
    setSettingsSection(section);
    setPresenting(false);
    setRouteError("");
    setHomeOpen(false);
    setSpaceIdOpen(null);
    setCreateOpen(true);
    setDocumentSettingsOpen(false);
    setImported(null);
    setSourceOpen(false);
    setSearchOpen(false);
    setDeveloperOpen(false);
    setActionError("");
    if (record) recordRoute({ kind: "manage", section });
  };
  const showDeveloper = async (record = true) => {
    if (!await finishDraft()) return;
    navigationVersion.current++;
    setConceptLoaded(true);
    setPresenting(false);
    setRouteError("");
    setHomeOpen(false);
    setSpaceIdOpen(null);
    setImported(null);
    setSourceOpen(false);
    setSearchOpen(false);
    setCreateOpen(false);
    setDeveloperOpen(true);
    if (record) recordRoute({ kind: "developer" });
  };
  const openNewDocument = (
    spaceId?: string,
    parentId?: string,
    templateId?: string,
  ) => {
    setNewDocumentTemplateId(templateId);
    setNewDocumentSpaceId(spaceId);
    setNewDocumentParentId(parentId);
    setActionError("");
    setNewDocumentOpen(true);
  };

  const handleReferenceReady = useCallback(
    (insert: ((title: string, href: string) => void) | null) => {
      referenceInserter.current = insert;
      if (insert && pendingReference.current) {
        const pending = pendingReference.current;
        pendingReference.current = null;
        insert(pending.title, pending.href);
      }
    },
    [],
  );
  const handleCommentReady = useCallback((
    read: (() => NonNullable<CommentAnchor> | null) | null,
  ) => {
    commentReader.current = read;
  }, []);
  const openCommentThread = useCallback((threadId: string) => {
    setCommentSelection(null);
    setCommentAnchor(null);
    setActiveCommentThreadId(threadId);
    setCommentsOpen(true);
  }, []);
  const updateCommentCount = useCallback((count: number) => {
    setConcept((current) =>
      current ? { ...current, openCommentCount: count } : current
    );
    setConcepts((current) =>
      current.map((item) =>
        item.id === concept?.id ? { ...item, openCommentCount: count } : item
      )
    );
  }, [concept?.id]);
  const insertReference = useCallback((title: string, href: string) => {
    if (
      referenceInserter.current && surface === "document" &&
      documentMode === "edit"
    ) {
      referenceInserter.current(title, href);
      return;
    }
    pendingReference.current = { title, href };
    setDocumentMode("edit");
    setSurface("document");
  }, [documentMode, surface]);
  const insertArtifactReference = useCallback((artifact: Artifact) => {
    if (!concept) return;
    insertReference(
      artifact.title,
      `/knowledge/${
        encodeURIComponent(concept.id)
      }?surface=artifacts&artifact=${encodeURIComponent(artifact.id)}`,
    );
  }, [concept, insertReference]);

  const spaceRouteVersion = spaces.map((item) => item.id).join("\0");
  useEffect(() => {
    if (!bootstrap?.canView || !hubReady || !sourcesReady) return;
    let active = true;
    const unavailable = () => {
      if (!active) return;
      setRouteError("This knowledge page is unavailable.");
      setHomeOpen(false);
      setSpaceIdOpen(null);
      setSearchOpen(false);
      setSourceOpen(false);
      setCreateOpen(false);
      setDeveloperOpen(false);
      setImported(null);
      setConceptLoaded(true);
    };
    const apply = async () => {
      const route = parseAppRoute(globalThis.location.pathname);
      if (!await finishDraft()) {
        globalThis.history.replaceState({}, "", lastRoutePath.current);
        return;
      }
      if (route.kind !== "not_found") {
        lastRoutePath.current = globalThis.location.pathname +
          globalThis.location.search;
      }
      try {
        if (route.kind === "home") return showHome(false);
        if (route.kind === "search") return showSearch(false);
        if (route.kind === "sources") return showSources(false);
        if (route.kind === "developer") {
          if (!bootstrap.canEdit) return unavailable();
          return showDeveloper(false);
        }
        if (route.kind === "space") {
          if (!spaceRouteVersion.split("\0").includes(route.id)) {
            return unavailable();
          }
          return showSpace(route.id, false);
        }
        if (route.kind === "manage") {
          if (!bootstrap.canEdit) return unavailable();
          const section = route.section === "connectors" &&
              bootstrap.access !== "owner"
            ? "general"
            : route.section;
          if (section !== route.section) {
            recordRoute({ kind: "manage", section }, true);
          }
          return showCreate(section, false);
        }
        if (route.kind === "concept") {
          await openHubConcept(route.id, false);
          return;
        }
        if (route.kind === "imported") {
          if (await openImported(route.sourceId, route.path, false) === false) {
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
    spaceRouteVersion,
  ]);

  if (fatal) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">Service error</p>
          <h1>Could not open OKF Hub</h1>
          <p>{fatal}</p>
          <Button
            className="primary"
            type="button"
            onClick={() => globalThis.location.reload()}
          >
            Retry
          </Button>
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
  if (!bootstrap.user) {
    return (
      <AuthScreen
        signupAllowed={Boolean(bootstrap.signupAllowed)}
        ssoProviders={bootstrap.ssoProviders ?? []}
        onAuthenticated={refresh}
      />
    );
  }
  if (bootstrap.setupRequired) {
    return <WorkspaceOnboarding onComplete={refresh} onSignOut={signOut} />;
  }
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
  const importedSourceLabel = imported?.sourceId === "shared"
    ? "Shared store"
    : imported?.sourceId === "notion"
    ? "Notion"
    : imported?.source && "repositoryUrl" in imported.source
    ? imported.source.repositoryUrl
    : "Git repository";
  const importedFolder = imported?.path.split("/").slice(0, -1).join(" / ") ||
    "Source root";
  const importedSourceName = importedSourceLabel.replace(/\.git$/, "").split(
    "/",
  ).filter(Boolean).at(-1) ?? importedSourceLabel;
  const activeSpace = spaceIdOpen
    ? spaces.find((item) => item.id === spaceIdOpen) ?? null
    : null;
  const activeView = homeOpen
    ? "home"
    : activeSpace
    ? "space"
    : searchOpen
    ? "search"
    : sourceOpen
    ? "sources"
    : developerOpen
    ? "developer"
    : createOpen
    ? "create"
    : imported
    ? "imported"
    : "concept";
  const pageSection = createOpen
    ? "Settings"
    : developerOpen
    ? "Developer"
    : activeSpace
    ? "Spaces"
    : homeOpen || searchOpen || sourceOpen
    ? "Company knowledge"
    : imported
    ? importedSourceLabel
    : concept?.space ?? "Hub-native knowledge";
  const displayedConcept =
    concept && view === "published" && concept.publishedMetadata
      ? { ...concept, ...concept.publishedMetadata }
      : concept;
  const pageTitle = homeOpen
    ? "Home"
    : activeSpace
    ? activeSpace.name
    : searchOpen
    ? "Search"
    : sourceOpen
    ? "Sources"
    : createOpen
    ? "Workspace"
    : developerOpen
    ? "API documentation"
    : imported?.title ?? displayedConcept?.title ?? "Hub-native knowledge";
  const statusTone =
    homeOpen || activeSpace || searchOpen || sourceOpen || createOpen ||
      developerOpen
      ? "online"
      : imported
      ? imported.source?.status === "sync_failed" ? "offline" : "online"
      : concept?.status === "archived"
      ? "offline"
      : concept?.lockedAt
      ? "connecting"
      : status === "syncing"
      ? "connecting"
      : status;
  const statusLabel = searchOpen || homeOpen
    ? "permission filtered"
    : activeSpace
    ? `${activeSpace.count} documents`
    : sourceOpen
    ? "connected sources"
    : createOpen
    ? "hub management"
    : developerOpen
    ? "developer API"
    : imported
    ? "read only"
    : concept?.status === "archived"
    ? "archived"
    : concept?.lockedAt
    ? "locked"
    : bootstrap.canEdit && view === "draft"
    ? status
    : "published";
  const statusDetail = homeOpen
    ? "Knowledge overview"
    : activeSpace
    ? "Space overview"
    : searchOpen
    ? "Authorised results"
    : sourceOpen
    ? "Source overview"
    : createOpen
    ? "Workspace and developer settings"
    : developerOpen
    ? "Self-hosted API reference"
    : imported
    ? imported.sourceId === "shared"
      ? "Shared-store owned"
      : imported.sourceId === "notion"
      ? "Notion owned"
      : "Repository owned"
    : concept?.lockedAt
    ? "Read only until unlocked"
    : bootstrap.canEdit && view === "published" && concept?.publishedRevision
    ? `Revision ${concept.publishedRevision} published`
    : bootstrap.canEdit
    ? saveState === "failed" ? "Save failed" : ""
    : "View only";
  const presentation = imported?.markdown
    ? {
      key: `imported-${imported.id}`,
      markdown: imported.markdown,
      meta: `${imported.type} · ${importedSourceLabel}`,
      title: imported.title,
    }
    : concept
    ? {
      key: `${concept.id}-${view}`,
      markdown: view === "draft" ? markdown : concept.published ?? "",
      meta: `${displayedConcept!.type} · ${concept.space}`,
      title: displayedConcept!.title,
    }
    : null;
  const canEditDocument = Boolean(
    bootstrap.canEdit && concept?.lockedAt === null,
  );
  const documentGovernance = concept
    ? (
      <DocumentGovernance
        key={concept.id}
        concept={concept}
        canManage={Boolean(bootstrap.canEdit && concept.status === "active")}
        view={view}
        onConceptUpdate={handleGovernanceUpdate}
        onSaveReady={handleGovernanceSaveReady}
        onViewPublished={() =>
          void finishDraft().then((saved) => {
            if (saved) setView("published");
          })}
      />
    )
    : null;
  return (
    <SidebarProvider className={focusMode ? "focus-mode" : undefined}>
      {!focusMode && (
        <AppSidebar
          access={bootstrap.access}
          activeImportId={imported?.id}
          activeSpaceId={activeSpace?.id}
          activeView={activeView}
          canEdit={Boolean(bootstrap.canEdit)}
          concepts={concepts}
          currentConceptId={concept?.id}
          imports={imports}
          sources={[
            ...repositories.map((source) => ({
              id: source.id,
              name: source.repositoryUrl.replace(/\.git$/, "").split("/")
                .filter(Boolean).at(-1) ?? "Git repository",
              count: source.conceptCount,
              kind: "git" as const,
            })),
            ...(sharedSource
              ? [{
                id: sharedSource.id,
                name: sharedSource.bucket,
                count: sharedSource.conceptCount,
                kind: "storage" as const,
              }]
              : []),
            ...(notionSource
              ? [{
                id: notionSource.id,
                name: "Notion",
                count: notionSource.conceptCount,
                kind: "notion" as const,
              }]
              : []),
          ]}
          spaces={spaces}
          user={bootstrap.user}
          workspace={bootstrap.workspace ?? {
            name: "OKF Hub",
            tagline: "Company knowledge",
            logo: "",
          }}
          onCreate={() => {
            showCreate("general");
          }}
          onCreateApp={() => {
            if (!concept) return;
            setSurface("artifacts");
            showHubConcept(concept.id);
          }}
          onCreateDocument={openNewDocument}
          onCreateSpace={() => {
            setActionError("");
            setSpaceDialogOpen(true);
          }}
          onArchiveDocument={(item) => {
            if (
              item.status === "active" &&
              !globalThis.confirm(`Archive ${item.title}?`)
            ) return;
            void documentLifecycle(
              item.id,
              item.status === "active" ? "archive" : "restore",
            );
          }}
          onToggleDocumentLock={(item) =>
            void documentLifecycle(
              item.id,
              item.lockedAt ? "unlock" : "lock",
            )}
          onMoveDocument={(item, destination) =>
            void moveDocument(item as Concept, destination)}
          onManageAccess={() => {
            showCreate("members");
          }}
          onOpenDeveloper={() => {
            showDeveloper();
          }}
          onOpenConcept={showHubConcept}
          onOpenHome={showHome}
          onOpenImported={(sourceId, path) => void openImported(sourceId, path)}
          onOpenSearch={openGlobalSearch}
          onOpenSpace={showSpace}
          onOpenSources={showSources}
          onSignOut={() => void signOut()}
        />
      )}
      <SidebarInset className="h-svh min-w-0 overflow-hidden bg-background">
        {!focusMode && (
          <WorkspaceHeader
            detail={statusDetail}
            section={pageSection}
            status={statusLabel}
            statusTone={statusTone}
            title={pageTitle}
            onSearch={openGlobalSearch}
            actions={imported
              ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 px-2.5 text-xs"
                  onClick={() => setAskOpen(true)}
                >
                  <Sparkles className="size-3.5" /> Ask OKF
                </Button>
              )
              : concept && !homeOpen && !activeSpace && !searchOpen &&
                  !sourceOpen &&
                  !createOpen && !developerOpen && !imported
              ? (
                <DocumentToolbar
                  actionBusy={actionBusy}
                  canEdit={canEditDocument}
                  collaborators={collaborators}
                  commentCount={concept.openCommentCount}
                  exportHref={concept.publishedRevision
                    ? `${SERVICE}${conceptPath(concept.id)}/export`
                    : undefined}
                  hasPublished={Boolean(concept.publishedRevision)}
                  hasUnpublishedChanges={!concept.publishedRevision ||
                    markdown.trimEnd() !==
                      (concept.published ?? "").trimEnd() ||
                    concept.hasUnpublishedChanges}
                  saveState={saveState}
                  onReviewChanges={() =>
                    void finishDraft().then((saved) => {
                      if (saved) setReviewOpen(true);
                    })}
                  onRetrySave={() => void finishDraft()}
                  onSaveAsTemplate={() => {
                    setActionError("");
                    setTemplateSaved(false);
                    void finishDraft().then((saved) => {
                      const current = latestConcept.current;
                      if (saved && current) {
                        setTemplateSnapshot({
                          title: view === "published"
                            ? current.publishedMetadata?.title ?? current.title
                            : current.title,
                          body: view === "published"
                            ? current.published ?? ""
                            : latestMarkdown.current,
                        });
                      }
                    });
                  }}
                  focusMode={focusMode}
                  mode={documentMode}
                  revisionCount={concept.revisions.length}
                  status={concept.status}
                  surface={surface}
                  view={view}
                  width={documentWidth}
                  onArchive={() => void lifecycle("archive")}
                  onAsk={() =>
                    void finishDraft().then((saved) => {
                      if (saved) setAskOpen(true);
                    })}
                  onComments={() => {
                    const editorAnchor = commentReader.current?.() ?? null;
                    const selection = globalThis.getSelection();
                    const selectedText = selection?.toString().trim() ?? "";
                    const selectedElement = selection?.anchorNode instanceof
                        Element
                      ? selection.anchorNode
                      : selection?.anchorNode?.parentElement;
                    // ponytail: quote-only fallback covers read views; add stable
                    // block anchors when inline comment decorations ship.
                    setCommentAnchor(
                      editorAnchor ||
                        (selectedText &&
                            selectedElement?.closest(".editor-frame")
                          ? { text: selectedText, from: 0, to: 0 }
                          : null),
                    );
                    setCommentSelection(null);
                    setActiveCommentThreadId(null);
                    setCommentsOpen(true);
                  }}
                  onHistory={() => setHistoryOpen((open) => !open)}
                  onModeChange={(mode) =>
                    void finishDraft().then((saved) => {
                      if (saved) setDocumentMode(mode);
                    })}
                  onPublish={() => void publish()}
                  onPresent={() => setPresenting(true)}
                  onReferences={() => setReferencesOpen(true)}
                  onRestore={() => void lifecycle("restore")}
                  onSettings={() => setDocumentSettingsOpen(true)}
                  onSurfaceChange={(next) =>
                    void finishDraft().then((saved) => {
                      if (saved) setSurface(next);
                    })}
                  onFocusModeChange={setFocusMode}
                  onViewChange={(next) =>
                    void finishDraft().then((saved) => {
                      if (saved) setView(next);
                    })}
                  onWidthChange={setDocumentWidth}
                />
              )
              : undefined}
          />
        )}
        <section className="workspace">
          {actionError &&
            (homeOpen || activeSpace || searchOpen || sourceOpen ||
              developerOpen) &&
            <p className="action-error" role="alert">{actionError}</p>}
          {focusMode && (
            <Button
              type="button"
              variant="outline"
              className="focus-exit"
              onClick={() => setFocusMode(false)}
            >
              Exit focus
            </Button>
          )}
          {routeError
            ? (
              <section className="empty-state route-unavailable">
                <p className="eyebrow">Unavailable</p>
                <h1>Knowledge page not found</h1>
                <p>{routeError}</p>
                <Button
                  className="primary"
                  type="button"
                  onClick={() => showHome()}
                >
                  Back to Home
                </Button>
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
                notion={notionSource}
                canEdit={Boolean(bootstrap.canEdit)}
                canConnectSources={bootstrap.access === "owner"}
                onOpenConcept={showHubConcept}
                onOpenImported={openImported}
                onCreate={() => openNewDocument()}
                onSearch={openGlobalSearch}
                onSources={showSources}
              />
            )
            : activeSpace
            ? (
              <SpacePanel
                space={activeSpace}
                concepts={concepts}
                canEdit={Boolean(bootstrap.canEdit)}
                onCreate={() => openNewDocument(activeSpace.id)}
                onOpenConcept={showHubConcept}
              />
            )
            : developerOpen
            ? <DeveloperApiDocumentation />
            : createOpen && bootstrap.canEdit
            ? (
              <WorkspaceSettings
                aiConfig={aiConfig}
                workspace={bootstrap.workspace ?? {
                  name: "OKF Hub",
                  tagline: "Company knowledge",
                  logo: "",
                }}
                spaces={spaces}
                templateDraftCache={templateDraftCache.current}
                templates={templates}
                invitations={bootstrap.invitations ?? []}
                members={bootstrap.members ?? []}
                groups={bootstrap.groups ?? []}
                connectors={connectors}
                repositories={repositories}
                sharedSource={sharedSource}
                notionSource={notionSource}
                canExportWorkspace={bootstrap.access === "owner"}
                canManageMembers={bootstrap.access === "owner"}
                canManageConnectors={bootstrap.access === "owner"}
                connectorBusy={sourceBusy || sharedBusy || notionBusy}
                busy={actionBusy}
                error={actionError}
                initialSection={settingsSection}
                onSectionChange={(section) => {
                  setSettingsSection(section);
                  recordRoute({ kind: "manage", section });
                }}
                onCreateSpace={createSpace}
                onRenameSpace={renameSpace}
                onDeleteSpace={deleteSpace}
                onCreateTemplate={createTemplate}
                onUpdateTemplate={updateTemplate}
                onUseTemplate={(id) =>
                  openNewDocument(undefined, undefined, id)}
                onDeleteTemplate={deleteTemplate}
                onUpdateWorkspace={updateWorkspace}
                onConnectConnector={connectConnector}
                onSetConnectorEnabled={setConnectorEnabled}
                onConnectGitHub={connectGitHubRepository}
                onCancel={() =>
                  concept ? showHubConcept(concept.id) : showHome()}
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
              <SourceWorkspace
                repositories={repositories}
                sharedSource={sharedSource}
                notionSource={notionSource}
                connectors={connectors}
                imports={imports}
                canManage={bootstrap.access === "owner"}
                sourceBusy={sourceBusy}
                sharedBusy={sharedBusy}
                notionBusy={notionBusy}
                sourceError={sourceError}
                sharedError={sharedError}
                notionError={notionError}
                scheduleBusyId={sourceScheduleBusyId}
                onConnectRepository={connectRepository}
                onConnectGitHub={connectGitHubRepository}
                onRefreshRepository={refreshRepository}
                onDisconnectRepository={disconnectRepository}
                onConnectShared={connectSharedSource}
                onRefreshShared={refreshSharedSource}
                onConnectNotion={connectNotionSource}
                onRefreshNotion={refreshNotionSource}
                onConnectConnector={connectConnector}
                onSetConnectorEnabled={setConnectorEnabled}
                onUpdateSchedule={updateSourceSchedule}
                onOpen={openImported}
              />
            )
            : imported?.markdown
            ? (
              <MilkdownProvider key={`imported-${imported.path}`}>
                <section className="imported-document-header">
                  <div className="imported-document-primary">
                    <div className="imported-document-location">
                      <Badge variant="outline">{imported.type}</Badge>
                      <span>
                        <FolderOpen /> {importedFolder}
                      </span>
                    </div>
                    <div className="imported-document-actions">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setPresenting(true)}
                      >
                        <Presentation /> Present
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => showSources()}
                      >
                        <GitBranch /> Source
                      </Button>
                    </div>
                  </div>
                  <div className="imported-document-meta">
                    <span>
                      <GitBranch /> {importedSourceName}
                    </span>
                    <span>
                      Revision{" "}
                      <code>{imported.sourceRevision.slice(0, 12)}</code>
                    </span>
                    <span>{imported.revisionCount} imported revisions</span>
                    <span>
                      Snapshot updated{" "}
                      {new Date(imported.importedAt).toLocaleString()}
                    </span>
                    {imported.source?.lastSyncedAt && (
                      <span>
                        Source checked {new Date(imported.source.lastSyncedAt)
                          .toLocaleString()}
                      </span>
                    )}
                    {imported.owner && (
                      <span>Source owner: {imported.owner}</span>
                    )}
                  </div>
                  {imported.source?.status === "sync_failed" && (
                    <p className="mt-3 text-sm text-destructive" role="status">
                      The latest source check failed. This is the retained
                      snapshot from{" "}
                      {new Date(imported.importedAt).toLocaleString()}.
                    </p>
                  )}
                </section>
                <div className="editor-frame read-only imported-editor">
                  <DocumentPreview
                    markdown={imported.markdown}
                    onLinkOpen={(href) => {
                      const path = resolveImportedLink(imported.path, href);
                      if (!path) return false;
                      const target = imports.find((item) =>
                        item.sourceId === imported.sourceId &&
                        (item.path === path || item.path === `${path}.md`)
                      );
                      if (!target) return false;
                      void openImported(target.sourceId, target.path);
                      return true;
                    }}
                  />
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
                  <Button
                    className="primary"
                    type="button"
                    disabled={actionBusy}
                    onClick={() => openNewDocument()}
                  >
                    Create document
                  </Button>
                )}
                {actionError && <p className="form-error">{actionError}</p>}
              </section>
            )
            : (
              <MilkdownProvider
                key={`${concept.id}-${concept.status}-${view}-${editorVersion}`}
              >
                <Dialog
                  open={documentSettingsOpen}
                  onOpenChange={setDocumentSettingsOpen}
                >
                  <DialogContent className="sm:max-w-[480px]">
                    <DialogHeader>
                      <DialogTitle>Document settings</DialogTitle>
                      <DialogDescription>
                        Moving a document keeps every draft, revision, artifact,
                        and audit event.
                      </DialogDescription>
                    </DialogHeader>
                    <form
                      onSubmit={(event) => void updateConcept(event)}
                      className="grid gap-4 py-2"
                    >
                      <div className="grid gap-2">
                        <label className="text-xs font-semibold">Title</label>
                        <Input
                          name="title"
                          maxLength={100}
                          defaultValue={concept.title}
                          required
                        />
                      </div>
                      <div className="grid gap-2">
                        <label className="text-xs font-semibold">Type</label>
                        <Input
                          name="type"
                          maxLength={50}
                          defaultValue={concept.type}
                          required
                        />
                      </div>
                      <div className="grid gap-2">
                        <label className="text-xs font-semibold">Intent</label>
                        <select
                          name="intent"
                          defaultValue={concept.intent}
                          className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                          required
                        >
                          <option value="canonical">
                            Maintained knowledge
                          </option>
                          <option value="working">Working document</option>
                          <option value="evidence">Evidence</option>
                          <option value="ephemeral">Ephemeral notes</option>
                        </select>
                      </div>
                      <div className="grid gap-2">
                        <label className="text-xs font-semibold">Space</label>
                        <select
                          name="spaceId"
                          defaultValue={concept.spaceId}
                          className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                          required
                        >
                          {spaces.map((space) => (
                            <option key={space.id} value={space.id}>
                              {space.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <DialogFooter className="mt-2">
                        <Button
                          variant="outline"
                          type="button"
                          onClick={() => setDocumentSettingsOpen(false)}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="default"
                          className="primary"
                          type="submit"
                          disabled={actionBusy}
                        >
                          Save settings
                        </Button>
                      </DialogFooter>
                    </form>
                  </DialogContent>
                </Dialog>

                <DocumentReferences
                  canEdit={Boolean(bootstrap.canEdit)}
                  conceptId={concept.id}
                  open={referencesOpen}
                  onInsert={insertReference}
                  onOpenChange={setReferencesOpen}
                  onOpenConcept={showHubConcept}
                />

                <DraftReview
                  open={reviewOpen}
                  onOpenChange={setReviewOpen}
                  onKeepEditing={() => {
                    setReviewOpen(false);
                    setView("draft");
                  }}
                  publishedMarkdown={concept.published}
                  draftMarkdown={markdown}
                  documentTitle={concept.title}
                  documentType={concept.type}
                  publishedMetadata={concept.publishedMetadata}
                  busy={actionBusy}
                  canPublish={canEditDocument}
                  error={actionError}
                  onPublish={() => void publish()}
                />
                <RevisionHistory
                  conceptId={concept.id}
                  revisions={concept.revisions}
                  publishedRevision={concept.publishedRevision}
                  reviewedRevision={concept.reviewedRevision}
                  reviewedAt={concept.reviewedAt}
                  reviewer={concept.reviewer}
                  open={historyOpen && Boolean(bootstrap.canEdit)}
                  canRestore={concept.status !== "archived" &&
                    !concept.lockedAt}
                  busy={actionBusy}
                  onOpenChange={setHistoryOpen}
                  onRestore={(number) => void restoreRevision(number)}
                />
                {actionError && (
                  <p className="action-error" role="alert">{actionError}</p>
                )}
                {concept.lockedAt && surface === "document" && (
                  <div className="document-lock-banner" role="status">
                    <Lock />
                    <div>
                      <strong>Document locked</strong>
                      <span>
                        Draft changes are paused until an editor unlocks it.
                      </span>
                    </div>
                    {bootstrap.canEdit && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={actionBusy}
                        onClick={() =>
                          void documentLifecycle(concept.id, "unlock")}
                      >
                        Unlock
                      </Button>
                    )}
                  </div>
                )}
                {surface === "document" && (
                  <div
                    className={`editor-frame ${
                      canEditDocument ? "" : "read-only"
                    }`}
                  >
                    {concept.status === "archived"
                      ? (
                        <section className="lifecycle-empty">
                          <p className="eyebrow">Archived</p>
                          <h1>{concept.title} is out of discovery</h1>
                          <p>
                            Its published revisions remain preserved and can be
                            restored.
                          </p>
                        </section>
                      )
                      : canEditDocument && view === "draft" &&
                          documentMode === "edit" &&
                          initialMarkdown !== null
                      ? (
                        <div
                          className={`canvas-container document-width-${documentWidth}`}
                          inert={actionBusy ? true : undefined}
                        >
                          <DocumentProperties
                            onSaveReady={(flush) => {
                              metadataFlush.current = flush;
                            }}
                            concept={concept}
                            spaces={spaces}
                            canEdit={canEditDocument}
                            onConceptUpdate={(updated) => {
                              const next = updated as Concept;
                              const merge = (current: Concept) => {
                                const merged = {
                                  ...next,
                                  ownerUserId: current.ownerUserId,
                                  owner: current.owner,
                                  reviewDueDate: current.reviewDueDate,
                                  reviewedRevision: current.reviewedRevision,
                                  reviewedAt: current.reviewedAt,
                                  reviewedBy: current.reviewedBy,
                                  reviewer: current.reviewer,
                                };
                                return {
                                  ...merged,
                                  freshness: deriveFreshness(merged),
                                };
                              };
                              if (latestConcept.current?.id === next.id) {
                                latestConcept.current = merge(
                                  latestConcept.current,
                                );
                              }
                              setConcept((current) =>
                                current?.id === next.id
                                  ? merge(current)
                                  : current
                              );
                              setConcepts((current) =>
                                current.map((item) =>
                                  item.id === next.id ? merge(item) : item
                                )
                              );
                            }}
                          />
                          {documentGovernance}
                          <DocumentEditor
                            key={editorVersion}
                            conceptId={concept.id}
                            collabEpoch={concept.collabEpoch}
                            initialMarkdown={initialMarkdown}
                            user={user}
                            canEdit={canEditDocument}
                            onMarkdown={saveMarkdown}
                            onSnapshotReady={handleDraftSnapshot}
                            onStatus={setStatus}
                            onCollaborators={setCollaborators}
                            onReferenceReady={handleReferenceReady}
                            onCommentReady={handleCommentReady}
                            onCommentSelection={setCommentSelection}
                            onCommentOpen={openCommentThread}
                          />
                        </div>
                      )
                      : (view === "draft" ? markdown : concept.published)
                      ? (
                        <div
                          className={`canvas-container document-width-${documentWidth}`}
                        >
                          <DocumentProperties
                            concept={displayedConcept!}
                            spaces={spaces}
                            canEdit={false}
                            onConceptUpdate={() => {}}
                          />
                          {documentGovernance}
                          <DocumentPreview
                            key={`${concept.publishedRevision}-${view}`}
                            conceptId={concept.id}
                            markdown={view === "draft"
                              ? markdown
                              : concept.published ?? ""}
                            onCommentOpen={openCommentThread}
                          />
                        </div>
                      )
                      : (
                        <div className="editor-loading">
                          Select a concept or draft to view content.
                        </div>
                      )}
                  </div>
                )}
                {surface === "artifacts" && (
                  <AppPanel
                    conceptId={concept.id}
                    conceptActive={concept.status === "active"}
                    onInsertReference={bootstrap.canEdit
                      ? insertArtifactReference
                      : undefined}
                  />
                )}
                {surface === "activity" && (
                  <WorkTracePanel
                    concept={concept}
                    concepts={concepts}
                    canEdit={canEditDocument}
                    busy={actionBusy}
                    onCreate={createWorkTrace}
                    onFold={foldWorkTrace}
                  />
                )}
              </MilkdownProvider>
            )}
        </section>
        {commentSelection && (
          <Button
            type="button"
            size="sm"
            className="fixed z-50 gap-1.5 shadow-lg"
            style={{
              top: commentSelection.top,
              left: commentSelection.left,
            }}
            onClick={() => {
              setCommentAnchor(commentSelection.anchor);
              setCommentSelection(null);
              setActiveCommentThreadId(null);
              setCommentsOpen(true);
            }}
          >
            <MessageSquare /> Comment
          </Button>
        )}
        {(imported || concept) && (
          <AskOKF
            open={askOpen}
            onOpenChange={setAskOpen}
            target={imported
              ? { kind: "imported", importId: imported.id, state: "source" }
              : {
                kind: "concept",
                conceptId: concept!.id,
                state: bootstrap.canEdit ? view : "published",
              }}
            documentTitle={(imported ?? displayedConcept)!.title}
            config={aiConfig}
            documentHref={imported
              ? routePath({
                kind: "imported",
                sourceId: imported.sourceId,
                path: imported.path,
              })
              : routePath({ kind: "concept", id: concept!.id })}
            documentVersion={imported
              ? `Source revision ${imported.sourceRevision}`
              : view === "published"
              ? `Published revision ${concept!.publishedRevision}`
              : saveState === "saved"
              ? `Saved draft · ${
                new Date(draftSavedAt || concept!.updatedAt)
                  .toLocaleTimeString()
              }`
              : "Save your latest draft changes"}
            sessions={askSessions.current}
            documentReady={Boolean(
              imported || view === "published" || saveState === "saved",
            )}
            onOpenSettings={() => {
              setAskOpen(false);
              showCreate("ai");
            }}
          />
        )}
        {concept && (
          <DocumentComments
            conceptId={concept.id}
            revisionNumber={concept.publishedRevision}
            open={commentsOpen}
            anchor={commentAnchor}
            activeThreadId={activeCommentThreadId}
            onOpenChange={(open) => {
              setCommentsOpen(open);
              if (!open) setActiveCommentThreadId(null);
            }}
            onAnchorChange={setCommentAnchor}
            onCountChange={updateCommentCount}
          />
        )}
      </SidebarInset>
      {bootstrap.canEdit && (
        <NewDocumentDialog
          open={newDocumentOpen}
          spaces={spaces}
          concepts={concepts}
          templates={templates}
          initialSpaceId={newDocumentSpaceId}
          initialParentId={newDocumentParentId}
          initialTemplateId={newDocumentTemplateId}
          busy={actionBusy}
          error={actionError}
          onOpenChange={setNewDocumentOpen}
          onCreate={createConcept}
        />
      )}
      <Dialog
        open={Boolean(templateSnapshot)}
        onOpenChange={(open) => {
          if (!open && !actionBusy) setTemplateSnapshot(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {templateSaved ? "Template saved" : "Save as template"}
            </DialogTitle>
            <DialogDescription>
              {templateSaved
                ? "Your reusable copy is ready in the template library."
                : "Create a reusable copy of this document for workspace editors."}
            </DialogDescription>
          </DialogHeader>
          {templateSaved
            ? (
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setTemplateSnapshot(null)}
                >
                  Done
                </Button>
                <Button
                  onClick={() => {
                    setTemplateSnapshot(null);
                    void showCreate("templates");
                  }}
                >
                  Open template library
                </Button>
              </DialogFooter>
            )
            : (
              <form
                className="grid gap-4"
                onSubmit={(event) =>
                  void createTemplate(event).then((saved) => {
                    if (saved) setTemplateSaved(true);
                  })}
              >
                <input
                  type="hidden"
                  name="body"
                  value={templateSnapshot?.body ?? ""}
                />
                <div className="grid gap-2">
                  <Label htmlFor="document-template-name">Template name</Label>
                  <Input
                    id="document-template-name"
                    name="name"
                    defaultValue={(templateSnapshot?.title ?? "").slice(0, 80)}
                    disabled={actionBusy}
                    required
                    maxLength={80}
                    autoFocus
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="document-template-description">
                    Description
                  </Label>
                  <Input
                    id="document-template-description"
                    name="description"
                    disabled={actionBusy}
                    maxLength={240}
                    placeholder="When should someone use this template?"
                  />
                </div>
                {actionError && (
                  <p className="form-error" role="alert">{actionError}</p>
                )}
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={actionBusy}
                    onClick={() => setTemplateSnapshot(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={actionBusy || !templateSnapshot?.body.trim()}
                  >
                    {actionBusy ? "Saving…" : "Save template"}
                  </Button>
                </DialogFooter>
              </form>
            )}
        </DialogContent>
      </Dialog>
      <Dialog open={spaceDialogOpen} onOpenChange={setSpaceDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create space</DialogTitle>
            <DialogDescription>
              Spaces group related documents and carry their access rules.
            </DialogDescription>
          </DialogHeader>
          <form
            className="sidebar-space-form"
            onSubmit={(event) => {
              void createSpace(event).then((created) => {
                if (created) {
                  setSpaceDialogIcon("");
                  setSpaceDialogOpen(false);
                }
              });
            }}
          >
            <Label htmlFor="sidebar-space-name">Name</Label>
            <Input
              id="sidebar-space-name"
              name="name"
              autoFocus
              maxLength={80}
              placeholder="Engineering"
              required
            />
            <span className="text-sm font-medium">Icon or emoji</span>
            <input
              type="hidden"
              name="icon"
              value={spaceDialogIcon}
              readOnly
            />
            <SpaceIconPicker
              value={spaceDialogIcon}
              label="Choose space icon or emoji"
              onChange={setSpaceDialogIcon}
            />
            {actionError && <p role="alert">{actionError}</p>}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setSpaceDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={actionBusy}>
                {actionBusy ? "Creating…" : "Create space"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {!presenting && (
        <CommandPalette
          canEdit={Boolean(bootstrap.canEdit)}
          concept={concept && !homeOpen && !searchOpen && !sourceOpen &&
              !createOpen && !imported
            ? concept
            : null}
          open={searchPaletteOpen}
          onCreate={() => openNewDocument()}
          onFocus={() => setFocusMode(true)}
          onOpenChange={setSearchPaletteOpen}
          onOpenConcept={showHubConcept}
          onOpenHome={showHome}
          onOpenImported={openImported}
          onOpenReferences={() => setReferencesOpen(true)}
          onOpenSearch={showSearch}
          onOpenSurface={setSurface}
          onPresent={() => setPresenting(true)}
        />
      )}
      {presenting && presentation && (
        <MilkdownProvider key={presentation.key}>
          <PresentationMode
            markdown={presentation.markdown}
            meta={presentation.meta}
            title={presentation.title}
            onClose={() => setPresenting(false)}
          />
        </MilkdownProvider>
      )}
    </SidebarProvider>
  );
}

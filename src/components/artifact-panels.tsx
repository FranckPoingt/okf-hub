import { MilkdownProvider } from "@milkdown/react";
import {
  ArrowUpRight,
  Blocks,
  ExternalLink,
  FileText,
  Link2,
  Lock,
  PanelRight,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  User,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useIsMobile } from "../hooks/use-mobile.ts";
import { api } from "../lib/api.ts";
import type {
  Artifact,
  ArtifactGalleryItem,
  ArtifactGalleryResponse,
  ArtifactSource,
  Concept,
  Space,
} from "../lib/models.ts";
import { DocumentPreview } from "./editor/document-editor.tsx";
import { AppFrame } from "./source-panels.tsx";
import { SpaceIcon } from "./space-icon.tsx";
import { EmptyState } from "./empty-state.tsx";
import { StatusBadge } from "./status-badge.tsx";
import { TrustBadge } from "./trust-badge.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Input } from "./ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./ui/sheet.tsx";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const stripFrontmatter = (markdown: string) =>
  markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();

const stripLeadingHeading = (markdown: string) =>
  markdown.replace(/^#\s+[^\n]*(?:\n|$)/, "").trim();

export function canOpenArtifactFirst(
  concept: Concept | null,
  apps: Artifact[],
  view: "draft" | "published",
  isOwner: boolean,
): boolean {
  if (
    !concept || concept.status !== "active" ||
    concept.type.toLocaleLowerCase() !== "artifact"
  ) {
    return false;
  }
  const hasActivatedApp = apps.some((app) => app.liveVersion !== null);
  if (hasActivatedApp) return true;
  return view === "draft" && isOwner && apps.length > 0;
}

function SourceList({
  sources,
  onOpenConcept,
}: {
  sources: ArtifactSource[];
  onOpenConcept: (id: string) => void;
}) {
  if (sources.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        Self-contained (no external sources declared)
      </span>
    );
  }
  return (
    <ul className="artifact-source-list" aria-label="Artifact sources">
      {sources.map((source, index) => (
        <li key={`${source.kind}-${source.href ?? source.label}-${index}`}>
          {source.conceptId
            ? (
              <button
                type="button"
                className="artifact-source-link"
                onClick={() => onOpenConcept(source.conceptId!)}
              >
                <FileText className="size-3.5 shrink-0" />
                <span className="truncate">{source.label}</span>
                <ArrowUpRight className="size-3 shrink-0 opacity-65" />
              </button>
            )
            : source.href
            ? (
              <a
                href={source.href}
                target="_blank"
                rel="noopener noreferrer"
                className="artifact-source-link"
              >
                <ExternalLink className="size-3.5 shrink-0" />
                <span className="truncate">{source.label}</span>
              </a>
            )
            : (
              <span className="artifact-source-pill">
                <Link2 className="size-3.5 shrink-0" />
                <span className="truncate">{source.label}</span>
              </span>
            )}
        </li>
      ))}
    </ul>
  );
}

const sandboxLabel = (grants: number) =>
  grants === 0
    ? "Sandboxed · No Hub access"
    : `Sandboxed · ${grants} ${grants === 1 ? "capability" : "capabilities"}`;

/** A description that only repeats the title tells the reader nothing. */
const distinctDescription = (description: string, title: string) =>
  description.trim().toLocaleLowerCase() === title.trim().toLocaleLowerCase()
    ? ""
    : description;

function ContextPanelBody({
  concept,
  activeApp,
  description,
  owner,
  showingLive,
  sources,
  contextMarkdown,
  onOpenAsDocument,
  onOpenConcept,
}: {
  concept: Concept;
  activeApp: Artifact;
  description: string;
  owner: string;
  showingLive: boolean;
  sources: ArtifactSource[];
  contextMarkdown: string;
  onOpenAsDocument: () => void;
  onOpenConcept: (id: string) => void;
}) {
  const cleanMarkdown = stripFrontmatter(contextMarkdown);
  const hasNotes = Boolean(stripLeadingHeading(cleanMarkdown));
  const handleLinkOpen = useCallback((href: string) => {
    const match = /^\/knowledge\/([^/?#]+)/.exec(href);
    if (!match) return false;
    try {
      onOpenConcept(decodeURIComponent(match[1]));
      return true;
    } catch {
      return false;
    }
  }, [onOpenConcept]);

  return (
    <div className="artifact-context-body">
      {distinctDescription(description, concept.title) && (
        <p className="artifact-context-summary">{description}</p>
      )}

      <dl className="artifact-context-dl">
        <div>
          <dt>Owner</dt>
          <dd>{owner}</dd>
        </div>
        <div>
          <dt>Status &amp; trust</dt>
          <dd className="flex flex-wrap items-center gap-1.5">
            {showingLive
              ? (
                <StatusBadge status="live">
                  <ShieldCheck />
                  Live · v{activeApp.liveVersion}
                </StatusBadge>
              )
              : (
                <StatusBadge status="draft">
                  Draft · v{activeApp.version}
                </StatusBadge>
              )}
            <TrustBadge trust={concept.trust} reason={concept.trustReason} />
            <Badge
              variant="outline"
              className="h-auto max-w-full shrink gap-1 py-0.5 text-left whitespace-normal"
            >
              <Lock className="size-3 shrink-0" />
              {sandboxLabel(activeApp.grants.length)}
            </Badge>
          </dd>
        </div>
        {activeApp.grants.length > 0 && (
          <div>
            <dt>Capabilities</dt>
            <dd className="flex flex-wrap gap-1">
              {activeApp.grants.map((grant) => (
                <code
                  key={grant}
                  className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                >
                  {grant}
                </code>
              ))}
            </dd>
          </div>
        )}
        <div>
          <dt>Updated</dt>
          <dd>
            <time dateTime={concept.updatedAt}>
              {dateFormatter.format(new Date(concept.updatedAt))}
            </time>
          </dd>
        </div>
        <div>
          <dt>Sources</dt>
          <dd>
            <SourceList sources={sources} onOpenConcept={onOpenConcept} />
          </dd>
        </div>
      </dl>

      <div className="artifact-context-notes">
        <div className="artifact-context-notes-header">
          <h3>Context document</h3>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={onOpenAsDocument}
          >
            <FileText className="size-3.5" />
            Open as document
          </Button>
        </div>
        {hasNotes
          ? (
            <div className="artifact-context-markdown editor-frame read-only">
              <MilkdownProvider
                key={`${concept.id}-${
                  showingLive ? "live" : "draft"
                }-${cleanMarkdown.length}`}
              >
                <DocumentPreview
                  conceptId={concept.id}
                  markdown={cleanMarkdown}
                  hidePageTitle
                  onLinkOpen={handleLinkOpen}
                />
              </MilkdownProvider>
            </div>
          )
          : (
            <p className="artifact-context-empty">
              No additional context notes in <code>context.md</code> yet.
            </p>
          )}
      </div>
    </div>
  );
}

export function ArtifactFirstView({
  concept,
  spaceIcon = "",
  apps,
  markdown,
  view,
  isOwner,
  canPublishApp,
  activating,
  onActivateApp,
  onOpenAsDocument,
  onOpenConcept,
  onOpenSpaceArtifacts,
  onViewChange,
}: {
  concept: Concept;
  spaceIcon?: string;
  apps: Artifact[];
  markdown: string;
  view: "draft" | "published";
  isOwner: boolean;
  canPublishApp: boolean;
  activating?: boolean;
  onActivateApp: (appId: string) => Promise<void>;
  onOpenAsDocument: () => void;
  onOpenConcept: (id: string) => void;
  onOpenSpaceArtifacts: (spaceId: string) => void;
  onViewChange: (view: "draft" | "published") => void;
}) {
  const isMobile = useIsMobile();
  const [contextOpen, setContextOpen] = useState(false);
  const [selectedAppId, setSelectedAppId] = useState<string>(
    () => (apps.find((item) => item.liveVersion !== null) ?? apps[0])?.id ?? "",
  );

  useEffect(() => {
    if (!apps.some((item) => item.id === selectedAppId)) {
      setSelectedAppId(
        (apps.find((item) => item.liveVersion !== null) ?? apps[0])?.id ?? "",
      );
    }
  }, [apps, selectedAppId]);

  const activeApp = useMemo(() => {
    const chosen = apps.find((item) => item.id === selectedAppId);
    if (
      chosen && (chosen.liveVersion !== null || (isOwner && view === "draft"))
    ) {
      return chosen;
    }
    return apps.find((item) => item.liveVersion !== null) ?? apps[0];
  }, [apps, isOwner, selectedAppId, view]);

  if (!activeApp) return null;

  const showingLive = activeApp.liveVersion !== null &&
    (activeApp.status === "live" || view === "published" || !isOwner);
  const usingPublishedContext = view === "published" || !isOwner;
  const meta = concept.artifactMeta;
  const owner = concept.owner?.name ?? "Unassigned";
  const description =
    (usingPublishedContext
      ? meta?.publishedDescription || meta?.description
      : meta?.description || meta?.publishedDescription) ||
    activeApp.description || "";
  const sources = meta?.sources ?? [];
  const contextMarkdown = usingPublishedContext
    ? concept.published ?? concept.draft ?? ""
    : markdown || concept.draft || concept.published || "";
  const canSwitchDraftLive = isOwner && activeApp.liveVersion !== null &&
    (activeApp.status === "changes_pending" ||
      Boolean(concept.published && concept.draft !== concept.published));
  const grantsLabel = sandboxLabel(activeApp.grants.length);

  return (
    <div className="artifact-first-shell">
      <header className="artifact-first-bar" aria-label="Artifact header">
        <div className="artifact-first-identity">
          <button
            type="button"
            className="artifact-space-chip"
            onClick={() => onOpenSpaceArtifacts(concept.spaceId)}
            title={`Browse artifacts in ${concept.space}`}
          >
            <SpaceIcon value={spaceIcon} className="size-3.5" />
            <span>{concept.space}</span>
          </button>
          <span className="artifact-bar-sep" aria-hidden="true">/</span>
          <h1 className="artifact-first-title">{concept.title}</h1>
        </div>

        <div className="artifact-first-meta" aria-label="Artifact metadata">
          <span className="artifact-meta-pill" title={`Owner: ${owner}`}>
            <User className="size-3.5" aria-hidden="true" />
            <span>{owner}</span>
          </span>

          {showingLive
            ? (
              <StatusBadge status="live">
                <ShieldCheck />
                <span>Live · v{activeApp.liveVersion}</span>
              </StatusBadge>
            )
            : (
              <StatusBadge status="draft">
                <span>
                  {activeApp.status === "changes_pending"
                    ? `Draft · v${activeApp.version} (live v${activeApp.liveVersion})`
                    : `Draft · v${activeApp.version}`}
                </span>
              </StatusBadge>
            )}

          <Badge
            variant="outline"
            className="hidden md:inline-flex"
            title={activeApp.grants.length
              ? `Allowed Hub capabilities: ${activeApp.grants.join(", ")}`
              : "Isolated sandboxed iframe with no Hub capabilities"}
          >
            <Lock className="size-3" />
            <span>{grantsLabel}</span>
          </Badge>

          {sources.length === 0
            ? (
              <span className="artifact-meta-pill hidden lg:inline-flex">
                <Link2 className="size-3.5" aria-hidden="true" />
                <span>Self-contained</span>
              </span>
            )
            : sources.length === 1 && !sources[0].href && !sources[0].conceptId
            ? (
              <span
                className="artifact-meta-pill hidden lg:inline-flex"
                title={`Source: ${sources[0].label}`}
              >
                <Link2 className="size-3.5" aria-hidden="true" />
                <span className="max-w-44 truncate">{sources[0].label}</span>
              </span>
            )
            : (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
                    />
                  }
                >
                  <Link2 className="size-3.5" />
                  <span>
                    {sources.length}{" "}
                    {sources.length === 1 ? "source" : "sources"}
                  </span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  {sources.map((source, index) =>
                    source.conceptId
                      ? (
                        <DropdownMenuItem
                          key={`${source.kind}-${source.conceptId}-${index}`}
                          onClick={() => onOpenConcept(source.conceptId!)}
                        >
                          <FileText />
                          <span className="truncate">{source.label}</span>
                        </DropdownMenuItem>
                      )
                      : source.href
                      ? (
                        <DropdownMenuItem
                          key={`${source.kind}-${source.href}-${index}`}
                          onClick={() =>
                            globalThis.open(
                              source.href,
                              "_blank",
                              "noopener,noreferrer",
                            )}
                        >
                          <ExternalLink />
                          <span className="truncate">{source.label}</span>
                        </DropdownMenuItem>
                      )
                      : (
                        <DropdownMenuItem
                          key={`${source.kind}-${source.label}-${index}`}
                          onClick={() => setContextOpen(true)}
                        >
                          <Link2 />
                          <span className="truncate">{source.label}</span>
                        </DropdownMenuItem>
                      )
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
        </div>

        <div className="artifact-first-actions">
          {apps.length > 1 && (
            <Select
              value={activeApp.id}
              onValueChange={(value) => {
                if (value) setSelectedAppId(value);
              }}
            >
              <SelectTrigger
                className="h-8 w-40 text-xs"
                aria-label="Select artifact app"
              >
                <SelectValue>{activeApp.title}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {apps.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {canSwitchDraftLive && (
            <div
              className="view-switch"
              role="group"
              aria-label="Artifact version"
            >
              <button
                type="button"
                className={view === "published" ? "active" : undefined}
                aria-pressed={view === "published"}
                onClick={() => onViewChange("published")}
              >
                Live
              </button>
              <button
                type="button"
                className={view === "draft" ? "active" : undefined}
                aria-pressed={view === "draft"}
                onClick={() => onViewChange("draft")}
              >
                Draft
              </button>
            </div>
          )}

          {canPublishApp && activeApp.status !== "live" && (
            <Button
              type="button"
              size="sm"
              className="h-8 px-2.5 text-xs"
              disabled={activating}
              onClick={() => void onActivateApp(activeApp.id)}
            >
              {activating ? "Activating…" : `Activate v${activeApp.version}`}
            </Button>
          )}

          <Button
            type="button"
            size="sm"
            variant={contextOpen ? "secondary" : "outline"}
            className="h-8 gap-1.5 px-2.5 text-xs"
            aria-expanded={contextOpen}
            aria-pressed={contextOpen}
            aria-controls="artifact-context-panel"
            onClick={() => setContextOpen((open) => !open)}
          >
            <PanelRight className="size-3.5" />
            <span>View context</span>
          </Button>

          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 px-2.5 text-xs"
            onClick={onOpenAsDocument}
          >
            <FileText className="size-3.5" />
            <span>Open as document</span>
          </Button>
        </div>
      </header>

      <div className="artifact-first-stage">
        <div
          className="artifact-first-frame-wrap"
          role="region"
          aria-label={`${concept.title} interactive app`}
        >
          <AppFrame
            artifact={activeApp}
            fullBleed
            preferLive={showingLive}
          />
        </div>

        {!isMobile && contextOpen && (
          <aside
            id="artifact-context-panel"
            aria-label="Artifact context"
            className="artifact-context-aside"
          >
            <div className="artifact-context-header">
              <div>
                <p className="eyebrow">Artifact context</p>
                <h2>{concept.title}</h2>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close context panel"
                onClick={() => setContextOpen(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
            <ContextPanelBody
              concept={concept}
              activeApp={activeApp}
              description={description}
              owner={owner}
              showingLive={showingLive}
              sources={sources}
              contextMarkdown={contextMarkdown}
              onOpenAsDocument={onOpenAsDocument}
              onOpenConcept={onOpenConcept}
            />
          </aside>
        )}
      </div>

      {isMobile && (
        <Sheet open={contextOpen} onOpenChange={setContextOpen}>
          <SheetContent
            side="right"
            id="artifact-context-panel"
            className="w-[min(92vw,26rem)] gap-0 overflow-y-auto p-0 sm:max-w-md"
          >
            <SheetHeader className="border-b px-4 py-3.5 pr-12">
              <SheetTitle>Context</SheetTitle>
              <SheetDescription className="truncate">
                {concept.title}
              </SheetDescription>
            </SheetHeader>
            <ContextPanelBody
              concept={concept}
              activeApp={activeApp}
              description={description}
              owner={owner}
              showingLive={showingLive}
              sources={sources}
              contextMarkdown={contextMarkdown}
              onOpenAsDocument={() => {
                setContextOpen(false);
                onOpenAsDocument();
              }}
              onOpenConcept={(id) => {
                setContextOpen(false);
                onOpenConcept(id);
              }}
            />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

export function ArtifactGallery({
  space = null,
  spaces,
  canEdit,
  onCreateArtifact,
  onOpenArtifacts,
  onOpenSpaceArtifacts,
  onOpenConcept,
}: {
  space?: Space | null;
  spaces: Space[];
  canEdit: boolean;
  onCreateArtifact: (spaceId?: string) => void;
  onOpenArtifacts: () => void;
  onOpenSpaceArtifacts: (spaceId: string) => void;
  onOpenConcept: (id: string) => void;
}) {
  const [items, setItems] = useState<ArtifactGalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const url = space
      ? `/api/artifact-gallery?spaceId=${encodeURIComponent(space.id)}`
      : "/api/artifact-gallery";
    api(url, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as ArtifactGalleryResponse & {
          error?: string;
        };
        if (!response.ok) {
          throw new Error(body.error ?? "Artifacts unavailable");
        }
        setItems(body.artifacts);
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        setError(
          cause instanceof Error ? cause.message : "Artifacts unavailable",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [space]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      [
        item.title,
        item.description,
        item.owner,
        item.space,
      ].some((field) => field.toLocaleLowerCase().includes(needle))
    );
  }, [items, query]);

  return (
    <section
      className="home-panel artifact-gallery-page"
      aria-labelledby="artifact-gallery-heading"
    >
      <div className="mx-auto w-full max-w-5xl">
        <header className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <p className="eyebrow">
              {space ? `${space.name} · Artifacts` : "Company artifacts"}
            </p>
            <div className="mt-1 flex items-center gap-3">
              {space && (
                <span className="flex size-10 items-center justify-center rounded-lg bg-muted text-xl text-muted-foreground">
                  <SpaceIcon value={space.icon} className="size-5" />
                </span>
              )}
              <h1
                id="artifact-gallery-heading"
                className="text-3xl font-semibold tracking-tight"
              >
                {space ? `${space.name} artifacts` : "Artifacts"}
              </h1>
            </div>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Interactive explanations, calculators, and tools backed by durable
              Markdown context and sandboxed static Apps.
            </p>
          </div>
          {canEdit && (
            <Button
              type="button"
              onClick={() => onCreateArtifact(space?.id)}
            >
              <Plus data-icon="inline-start" />
              New artifact
            </Button>
          )}
        </header>

        <div className="artifact-gallery-controls mt-7">
          {spaces.length > 0 && (
            <nav
              className="artifact-space-pills"
              aria-label="Filter artifacts by space"
            >
              <button
                type="button"
                className={`artifact-filter-pill ${!space ? "active" : ""}`}
                aria-current={!space ? "page" : undefined}
                onClick={onOpenArtifacts}
              >
                All spaces
              </button>
              {spaces.map((item) => {
                const active = space?.id === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`artifact-filter-pill ${active ? "active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    onClick={() => onOpenSpaceArtifacts(item.id)}
                  >
                    <SpaceIcon value={item.icon} className="size-3.5" />
                    <span>{item.name}</span>
                  </button>
                );
              })}
            </nav>
          )}

          <div className="artifact-gallery-search">
            <Search
              className="pointer-events-none size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter artifacts by title, description, or owner…"
              aria-label="Filter artifacts"
              className="pl-9"
            />
          </div>
        </div>

        {error && (
          <p className="source-error mt-6" role="alert">
            {error}
          </p>
        )}

        {loading
          ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              Loading authorised artifacts…
            </div>
          )
          : filtered.length > 0
          ? (
            <div
              className="artifact-gallery-grid mt-6"
              role="list"
              aria-label={space
                ? `${space.name} artifacts`
                : "Workspace artifacts"}
            >
              {filtered.map((item) => (
                <article
                  key={item.id}
                  role="listitem"
                  className="artifact-gallery-card"
                >
                  <button
                    type="button"
                    className="artifact-gallery-card-button"
                    onClick={() => onOpenConcept(item.id)}
                  >
                    <div className="artifact-gallery-card-top">
                      <span className="artifact-gallery-card-space">
                        <SpaceIcon
                          value={item.spaceIcon}
                          className="size-3.5"
                        />
                        <span>{item.space}</span>
                      </span>
                      <span className="artifact-gallery-card-badges">
                        {item.liveVersion !== null
                          ? (
                            <StatusBadge status="live">
                              <ShieldCheck />
                              Live · v{item.liveVersion}
                            </StatusBadge>
                          )
                          : item.appCount > 0
                          ? (
                            <StatusBadge status="draft">
                              Draft app · v{item.version ?? 1}
                            </StatusBadge>
                          )
                          : item.publishedRevision !== null
                          ? <Badge variant="outline">Published</Badge>
                          : <StatusBadge status="draft" />}
                        {/* Plain badge: a tooltip trigger cannot nest in the card button. */}
                        <TrustBadge trust={item.trust} />
                        {item.trustReason && (
                          <span className="sr-only">{item.trustReason}</span>
                        )}
                      </span>
                    </div>

                    <div className="artifact-gallery-card-body">
                      <h2 className="artifact-gallery-card-title">
                        {item.title}
                      </h2>
                      {distinctDescription(item.description, item.title) && (
                        <p className="artifact-gallery-card-description">
                          {item.description}
                        </p>
                      )}
                    </div>

                    <div className="artifact-gallery-card-footer">
                      <span className="artifact-gallery-card-owner">
                        <User
                          className="size-3.5 shrink-0"
                          aria-hidden="true"
                        />
                        <span className="truncate">
                          {item.owner || "Unassigned"}
                        </span>
                      </span>
                      <time
                        dateTime={item.updatedAt}
                        className="artifact-gallery-card-date"
                      >
                        {dateFormatter.format(new Date(item.updatedAt))}
                      </time>
                    </div>
                  </button>
                </article>
              ))}
            </div>
          )
          : (
            <EmptyState
              className="mt-6 rounded-xl border bg-card"
              icon={query.trim() ? <Blocks /> : <Sparkles />}
              title={query.trim()
                ? "No matching artifacts"
                : space
                ? `No artifacts in ${space.name} yet`
                : "No artifacts in this workspace yet"}
              description={query.trim()
                ? "Try clearing the filter or browsing all spaces."
                : canEdit
                ? "Create an Artifact document with context.md frontmatter and attach a static App bundle."
                : "Live artifacts you have permission to view will appear here."}
            >
              {canEdit && !query.trim() && (
                <Button
                  type="button"
                  onClick={() => onCreateArtifact(space?.id)}
                >
                  <Plus data-icon="inline-start" />
                  New artifact
                </Button>
              )}
            </EmptyState>
          )}
      </div>
    </section>
  );
}

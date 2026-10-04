import {
  ArrowRight,
  Database,
  FileText,
  GitBranch,
  Plus,
  Search,
} from "lucide-react";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import type {
  Concept,
  ImportedConcept,
  NotionSource,
  RepositorySource,
  SharedSource,
  Space,
} from "../lib/models.ts";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

export function HomePanel(
  {
    concepts,
    spaces,
    imports,
    repositories,
    shared,
    notion,
    canEdit,
    canConnectSources = false,
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
    notion: NotionSource | null;
    canEdit: boolean;
    canConnectSources?: boolean;
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
  const sourceLabels = new Map(
    repositories.map((source) => [
      source.id,
      source.githubFullName ??
        source.repositoryUrl.split("/").at(-1)?.replace(/\.git$/, "") ??
        "Git repository",
    ]),
  );
  if (shared) sourceLabels.set(shared.id, shared.bucket);
  if (notion) sourceLabels.set(notion.id, "Notion");
  const recent = [
    ...concepts.map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      location: item.space,
      updatedAt: item.updatedAt,
      imported: false as const,
      open: () => onOpenConcept(item.id),
    })),
    ...imports.map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      location: sourceLabels.get(item.sourceId) ?? "Connected source",
      updatedAt: item.importedAt,
      imported: true as const,
      open: () => void onOpenImported(item.sourceId, item.path),
    })),
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(
    0,
    8,
  );
  const drafts = concepts.filter((item) =>
    item.status === "active" &&
    (item.hasUnpublishedChanges ?? !item.publishedRevision)
  ).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const sources = [
    ...repositories,
    ...(shared ? [shared] : []),
    ...(notion ? [notion] : []),
  ];
  const sourceAttention =
    sources.filter((item) => item.status === "sync_failed")
      .length;
  const firstKnowledge = !imports.length &&
    !concepts.some((item) =>
      item.status === "active" && item.publishedRevision
    );

  return (
    <section className="home-panel">
      <div className="mx-auto w-full max-w-4xl">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="eyebrow">Company knowledge</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Home</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Pick up where you left off or find trusted knowledge.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canEdit && (
              <Button type="button" onClick={onCreate}>
                <Plus data-icon="inline-start" />
                New document
              </Button>
            )}
            {canConnectSources && (
              <Button type="button" variant="outline" onClick={onSources}>
                <Database data-icon="inline-start" />
                {sources.length ? "Manage sources" : "Connect a source"}
              </Button>
            )}
          </div>
        </header>

        <Button
          variant="outline"
          className="mt-8 h-11 w-full justify-start gap-3 px-3 text-muted-foreground shadow-none"
          type="button"
          onClick={onSearch}
        >
          <Search />
          <span className="flex-1 text-left">Search company knowledge</span>
          <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
            ⌘K
          </kbd>
        </Button>

        <div className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{concepts.length + imports.length} documents</span>
          <span aria-hidden="true">·</span>
          <span>
            {spaces.length} {spaces.length === 1 ? "space" : "spaces"}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {sources.length} connected{" "}
            {sources.length === 1 ? "source" : "sources"}
          </span>
          {sourceAttention > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <button
                className="font-medium text-destructive hover:underline"
                type="button"
                onClick={onSources}
              >
                {sourceAttention} need attention
              </button>
            </>
          )}
        </div>

        {firstKnowledge && (
          <div className="mt-6 rounded-lg border bg-card p-5">
            <h2 className="text-base font-semibold">
              {canEdit
                ? "Start your team's knowledge hub"
                : "Your team's knowledge starts here"}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {canEdit
                ? "Start with a document, use a template, and publish when it is ready for teammates to read. Connected sources bring existing knowledge into the same search."
                : "Published pages and connected-source documents appear here when your team shares them with you. Ask a workspace owner if you need access to existing knowledge."}
            </p>
            {canEdit && (
              <div className="mt-4 flex flex-wrap gap-2">
                <Button type="button" onClick={onCreate}>
                  <Plus /> Create a document
                </Button>
                {drafts[0] && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onOpenConcept(drafts[0].id)}
                  >
                    Continue {drafts[0].title}
                  </Button>
                )}
                {canConnectSources && !sources.length && (
                  <Button type="button" variant="outline" onClick={onSources}>
                    <Database /> Connect existing knowledge
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        <Tabs className="mt-7" defaultValue="recent">
          <TabsList variant="line" className="w-full justify-start border-b">
            <TabsTrigger value="recent" className="flex-none px-3">
              Recent
            </TabsTrigger>
            {canEdit && (
              <TabsTrigger value="drafts" className="flex-none px-3">
                Drafts
                {drafts.length > 0 && (
                  <Badge variant="secondary" className="h-5 min-w-5 px-1.5">
                    {drafts.length}
                  </Badge>
                )}
              </TabsTrigger>
            )}
            <TabsTrigger value="sources" className="flex-none px-3">
              Sources
            </TabsTrigger>
          </TabsList>

          <TabsContent value="recent" className="pt-3">
            <div className="overflow-hidden rounded-lg border bg-card">
              {recent.map((item) => (
                <Button
                  variant="ghost"
                  className="grid h-auto w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 rounded-none border-b px-4 py-3 text-left last:border-b-0 hover:bg-muted/60"
                  type="button"
                  key={`${item.imported ? "imported" : "native"}-${item.id}`}
                  onClick={item.open}
                >
                  <span className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    {item.imported ? <GitBranch /> : <FileText />}
                  </span>
                  <span className="min-w-0">
                    <strong className="block truncate text-sm font-medium text-foreground">
                      {item.title}
                    </strong>
                    <small className="mt-0.5 block truncate font-normal text-muted-foreground">
                      {item.type} · {item.location}
                    </small>
                  </span>
                  <time className="font-normal text-muted-foreground">
                    {dateFormatter.format(new Date(item.updatedAt))}
                  </time>
                </Button>
              ))}
              {!recent.length && (
                <p className="px-4 py-12 text-center text-sm text-muted-foreground">
                  {canEdit
                    ? "Create a document or connect a source to add knowledge here."
                    : "No documents have been shared with you yet."}
                </p>
              )}
            </div>
          </TabsContent>

          {canEdit && (
            <TabsContent value="drafts" className="pt-3">
              <div className="overflow-hidden rounded-lg border bg-card">
                {drafts.map((item) => (
                  <Button
                    variant="ghost"
                    className="grid h-auto w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 rounded-none border-b px-4 py-3 text-left last:border-b-0 hover:bg-muted/60"
                    type="button"
                    key={item.id}
                    onClick={() => onOpenConcept(item.id)}
                  >
                    <span className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <FileText />
                    </span>
                    <span className="min-w-0">
                      <strong className="block truncate text-sm font-medium text-foreground">
                        {item.title}
                      </strong>
                      <small className="mt-0.5 block truncate font-normal text-muted-foreground">
                        {item.publishedRevision
                          ? `Changes to revision ${item.publishedRevision}`
                          : "Never published"} · {item.space}
                      </small>
                    </span>
                    <time className="font-normal text-muted-foreground">
                      {dateFormatter.format(new Date(item.updatedAt))}
                    </time>
                  </Button>
                ))}
                {!drafts.length && (
                  <div className="px-4 py-12 text-center">
                    <p className="text-sm font-medium">No unpublished drafts</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      New documents and changes to published pages appear here
                      until you publish them.
                    </p>
                  </div>
                )}
              </div>
            </TabsContent>
          )}

          <TabsContent value="sources" className="pt-3">
            <div className="overflow-hidden rounded-lg border bg-card">
              {sources.map((source) => (
                <Button
                  variant="ghost"
                  className="grid h-auto w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 rounded-none border-b px-4 py-3 text-left last:border-b-0 hover:bg-muted/60"
                  type="button"
                  key={source.id}
                  onClick={onSources}
                >
                  <span className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    {source.kind === "git" || source.kind === "github"
                      ? <GitBranch />
                      : <Database />}
                  </span>
                  <span className="min-w-0">
                    <strong className="block truncate text-sm font-medium text-foreground">
                      {source.kind === "s3"
                        ? source.bucket
                        : source.kind === "notion"
                        ? "Notion"
                        : source.githubFullName ?? source.repositoryUrl}
                    </strong>
                    <small className="mt-0.5 block truncate font-normal text-muted-foreground">
                      {source.conceptCount} imported documents
                    </small>
                  </span>
                  <Badge
                    variant={source.status === "sync_failed"
                      ? "destructive"
                      : "outline"}
                  >
                    {source.status === "current"
                      ? "Current"
                      : source.status === "syncing"
                      ? "Syncing"
                      : "Needs attention"}
                  </Badge>
                </Button>
              ))}
              {!sources.length && (
                <div className="px-4 py-12 text-center">
                  <p className="text-sm font-medium">No sources connected</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {canConnectSources
                      ? "Connect GitHub, object storage, or Notion to bring in trusted knowledge."
                      : "A workspace owner can connect repositories, object storage, or Notion."}
                  </p>
                  {canConnectSources && (
                    <Button type="button" className="mt-4" onClick={onSources}>
                      <Database /> Connect a source
                    </Button>
                  )}
                </div>
              )}
            </div>
            <Button
              variant="ghost"
              className="mt-2"
              type="button"
              onClick={onSources}
            >
              {canConnectSources ? "Manage sources" : "View sources"}
              <ArrowRight data-icon="inline-end" />
            </Button>
          </TabsContent>
        </Tabs>
      </div>
    </section>
  );
}

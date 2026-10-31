import { useEffect, useState } from "react";
import {
  ArrowRight,
  Database,
  FileText,
  GitBranch,
  Plus,
  Search,
} from "lucide-react";
import { formatReviewDate, FreshnessBadge } from "./knowledge-freshness.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { api } from "../lib/api.ts";
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
    isOwner,
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
    isOwner: boolean;
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
  const [reused, setReused] = useState<
    { id: string; title: string; viewers: number }[]
  >([]);
  useEffect(() => {
    if (!isOwner) return;
    api("/api/artifact-usage").then((response) =>
      response.ok ? response.json() : { reused: [] }
    ).then((result) => setReused(result.reused)).catch(() => setReused([]));
  }, [isOwner]);
  const [tab, setTab] = useState("recent");
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
      freshness: item.freshness,
      reviewDueDate: item.reviewDueDate,
      open: () => onOpenConcept(item.id),
    })),
    ...imports.map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      location: sourceLabels.get(item.sourceId) ?? "Connected source",
      updatedAt: item.importedAt,
      imported: true as const,
      freshness: undefined,
      reviewDueDate: undefined,
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
  const attention = concepts.filter((item) =>
    item.status === "active" && item.publishedRevision &&
    (item.publishedMetadata?.intent ?? item.intent) === "canonical" &&
    (!item.owner ||
      ["unreviewed", "due", "overdue"].includes(item.freshness.status))
  ).sort((left, right) => {
    const priority = {
      overdue: 0,
      due: 1,
      unreviewed: 2,
      current: 3,
      unpublished: 4,
    };
    return priority[left.freshness.status] - priority[right.freshness.status] ||
      (left.reviewDueDate ?? "9999").localeCompare(
        right.reviewDueDate ?? "9999",
      ) ||
      left.title.localeCompare(right.title);
  });
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
                {sourceAttention}{" "}
                {sourceAttention === 1 ? "source needs" : "sources need"}{" "}
                attention
              </button>
            </>
          )}
          {canEdit && attention.length > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <button
                className="font-medium text-foreground hover:underline"
                type="button"
                onClick={() => setTab("attention")}
              >
                {attention.length}{" "}
                {attention.length === 1 ? "page needs" : "pages need"} attention
              </button>
            </>
          )}
        </div>

        {isOwner && reused.length > 0 && (
          <section className="mt-5 rounded-lg border bg-card p-4 text-sm">
            <strong>
              {reused.length} {reused.length === 1 ? "artifact" : "artifacts"}
              {" "}
              reused by others in the last 30 days
            </strong>
            <ul className="mt-2 grid gap-1 text-muted-foreground">
              {reused.slice(0, 5).map((item) => (
                <li key={item.id}>
                  <button
                    className="hover:underline"
                    type="button"
                    onClick={() => onOpenConcept(item.id)}
                  >
                    {item.title}
                  </button>{" "}
                  · {item.viewers} {item.viewers === 1 ? "person" : "people"}
                </li>
              ))}
            </ul>
          </section>
        )}

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

        <Tabs
          className="mt-7"
          value={tab}
          onValueChange={(value) => setTab(String(value))}
        >
          <TabsList
            variant="line"
            className="h-auto! min-h-8 w-full flex-wrap justify-start border-b"
          >
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
            {canEdit && (
              <TabsTrigger value="attention" className="flex-none px-3">
                Needs attention
                {attention.length > 0 && (
                  <Badge variant="secondary" className="h-5 min-w-5 px-1.5">
                    {attention.length}
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
                  <span className="flex flex-col items-end gap-1.5">
                    {item.freshness && (
                      <FreshnessBadge
                        freshness={item.freshness}
                        reviewDueDate={item.reviewDueDate}
                      />
                    )}
                    <time
                      dateTime={item.updatedAt}
                      title={`${
                        item.imported ? "Snapshot updated" : "Document updated"
                      } ${new Date(item.updatedAt).toLocaleString()}`}
                      className="font-normal text-muted-foreground"
                    >
                      {dateFormatter.format(new Date(item.updatedAt))}
                    </time>
                  </span>
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

          {canEdit && (
            <TabsContent value="attention" className="pt-3">
              <p className="mb-3 text-xs text-muted-foreground">
                Published lasting knowledge that needs an owner or a review.
                Unpublished work stays in Drafts.
              </p>
              <div className="overflow-hidden rounded-lg border bg-card">
                {attention.map((item) => (
                  <Button
                    variant="ghost"
                    className="flex h-auto w-full flex-wrap items-center justify-start gap-3 rounded-none border-b px-4 py-3 text-left whitespace-normal last:border-b-0 hover:bg-muted/60"
                    type="button"
                    key={item.id}
                    onClick={() => onOpenConcept(item.id)}
                  >
                    <span className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <FileText />
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm font-medium text-foreground">
                        {item.publishedMetadata?.title ?? item.title}
                      </strong>
                      <small className="mt-0.5 block font-normal text-muted-foreground">
                        {item.space} · {item.owner?.name ?? "Unassigned"}
                        {item.reviewDueDate &&
                          ` · Review due ${
                            formatReviewDate(item.reviewDueDate)
                          }`}
                      </small>
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {!item.owner && (
                        <Badge
                          variant="secondary"
                          title="Assign an owner to keep this published knowledge accountable."
                        >
                          Unassigned owner
                        </Badge>
                      )}
                      {item.freshness.status !== "current" && (
                        <FreshnessBadge
                          freshness={item.freshness}
                          reviewDueDate={item.reviewDueDate}
                        />
                      )}
                    </span>
                  </Button>
                ))}
                {!attention.length && (
                  <div className="px-4 py-12 text-center">
                    <p className="text-sm font-medium">
                      No knowledge needs attention
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Published lasting knowledge has an owner and no pending
                      reviews.
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
                      {source.lastSyncedAt &&
                        ` · Last successful check ${
                          dateFormatter.format(new Date(source.lastSyncedAt))
                        }`}
                    </small>
                  </span>
                  <Badge
                    variant={source.status === "sync_failed"
                      ? "destructive"
                      : "outline"}
                  >
                    {source.status === "current"
                      ? "Sync current"
                      : source.status === "syncing"
                      ? "Syncing"
                      : "Source check failed"}
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

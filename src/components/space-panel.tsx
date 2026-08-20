import { FileText, Plus } from "lucide-react";
import type { Concept, Space } from "../lib/models.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { SpaceIcon } from "./space-icon.tsx";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

export function SpacePanel({
  space,
  concepts,
  canEdit,
  onCreate,
  onOpenConcept,
}: {
  space: Space;
  concepts: Concept[];
  canEdit: boolean;
  onCreate: () => void;
  onOpenConcept: (id: string) => void;
}) {
  const documents = concepts.filter((item) => item.spaceId === space.id);
  const alphabetical = [...documents].sort((left, right) =>
    left.title.localeCompare(right.title)
  );
  const recent = [...documents].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  );
  const rows = (items: Concept[]) => (
    <div className="overflow-hidden rounded-lg border bg-card">
      {items.map((item) => (
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
              {item.type}
              {!item.publishedRevision && item.status === "active"
                ? " · Draft"
                : ""}
              {item.status === "archived" ? " · Archived" : ""}
            </small>
          </span>
          <time className="font-normal text-muted-foreground">
            {dateFormatter.format(new Date(item.updatedAt))}
          </time>
        </Button>
      ))}
      {!items.length && (
        <div className="px-4 py-12 text-center">
          <p className="text-sm font-medium">No documents in this space</p>
          {canEdit && (
            <Button className="mt-3" type="button" onClick={onCreate}>
              <Plus data-icon="inline-start" />
              New document
            </Button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <section className="home-panel">
      <div className="mx-auto w-full max-w-4xl">
        <header className="flex items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-lg bg-muted text-xl text-muted-foreground">
                <SpaceIcon value={space.icon} className="size-5" />
              </span>
              <h1 className="text-3xl font-semibold tracking-tight">
                {space.name}
              </h1>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              {documents.length}{" "}
              {documents.length === 1 ? "document" : "documents"} in this space.
            </p>
          </div>
          {canEdit && (
            <Button type="button" onClick={onCreate}>
              <Plus data-icon="inline-start" />
              New document
            </Button>
          )}
        </header>

        <Tabs className="mt-8" defaultValue="documents">
          <TabsList variant="line" className="w-full justify-start border-b">
            <TabsTrigger value="documents" className="flex-none px-3">
              Documents
              <Badge variant="secondary" className="h-5 min-w-5 px-1.5">
                {documents.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="recent" className="flex-none px-3">
              Recently changed
            </TabsTrigger>
          </TabsList>
          <TabsContent value="documents" className="pt-3">
            {rows(alphabetical)}
          </TabsContent>
          <TabsContent value="recent" className="pt-3">
            {rows(recent)}
          </TabsContent>
        </Tabs>
      </div>
    </section>
  );
}

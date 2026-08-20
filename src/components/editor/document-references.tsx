import { ArrowUpRight, Link2, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api.ts";
import type {
  SearchRelationship,
  SearchResponse,
  SearchResult,
} from "../../lib/models.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet.tsx";

export function DocumentReferences({
  canEdit,
  conceptId,
  open,
  onInsert,
  onOpenChange,
  onOpenConcept,
}: {
  canEdit: boolean;
  conceptId: string;
  open: boolean;
  onInsert: (title: string, href: string) => void;
  onOpenChange: (open: boolean) => void;
  onOpenConcept: (id: string) => void;
}) {
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const response = await api("/api/search");
    const body = await response.json() as SearchResponse & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "References unavailable");
    setResult(body);
  }, []);
  useEffect(() => {
    if (open) void load().catch((cause) => setError(cause.message));
  }, [load, open]);

  const current = result?.results.find((item) => item.id === conceptId);
  const candidates = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return result?.results.filter((item) =>
      item.kind === "hub-native" && item.id !== conceptId &&
      (!needle ||
        `${item.title} ${item.type}`.toLocaleLowerCase().includes(needle))
    ) ?? [];
  }, [conceptId, query, result]);
  const openPage = (item: SearchRelationship) => {
    if (item.kind !== "hub-native") return;
    onOpenChange(false);
    onOpenConcept(item.id);
  };
  const insert = (item: SearchResult) => {
    onInsert(item.title, `/knowledge/${encodeURIComponent(item.id)}`);
    onOpenChange(false);
  };
  const relationships = (label: string, items: SearchRelationship[] = []) => (
    <section className="grid gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label} <span className="tabular-nums">{items.length}</span>
      </h3>
      {items.length
        ? items.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant="ghost"
            className="h-auto justify-start gap-2 px-2 py-2 text-left"
            onClick={() => openPage(item)}
          >
            <Link2 className="size-3.5" />
            <span className="truncate">{item.title}</span>
            <ArrowUpRight className="ml-auto size-3.5" />
          </Button>
        ))
        : <p className="text-sm text-muted-foreground">None yet.</p>}
    </section>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>References</SheetTitle>
          <SheetDescription>
            Links remain portable Markdown; backlinks are derived from
            accessible pages.
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-6 overflow-y-auto px-4 pb-6">
          {error && <p className="source-error" role="alert">{error}</p>}
          {relationships("Links to", current?.links)}
          {relationships("Linked from", current?.backlinks)}
          {canEdit && (
            <section className="grid gap-3 border-t pt-5">
              <h3 className="text-sm font-semibold">Insert a page reference</h3>
              <Input
                type="search"
                value={query}
                placeholder="Find a page…"
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="grid gap-1">
                {candidates.map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    variant="ghost"
                    className="h-auto justify-start gap-2 px-2 py-2"
                    onClick={() => insert(item)}
                  >
                    <Plus className="size-3.5" />
                    <span className="truncate">{item.title}</span>
                    <small className="ml-auto text-muted-foreground">
                      {item.type}
                    </small>
                  </Button>
                ))}
              </div>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

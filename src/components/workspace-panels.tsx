import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type {
  Concept,
  SearchRelationship,
  SearchResponse,
  WorkTrace,
} from "../lib/models.ts";
import { Button } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./ui/popover.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { Search, SlidersHorizontal, X } from "lucide-react";

export function SearchPanel(
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
  const [filtersOpen, setFiltersOpen] = useState(false);
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

  const runSearch = () => {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (type) params.set("type", type);
    if (tag) params.set("tag", tag);
    if (includeArchived) params.set("includeArchived", "true");
    void load(params);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    runSearch();
  };
  const activeFilters = Number(Boolean(type)) + Number(Boolean(tag)) +
    Number(includeArchived);
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
      <div className="grid gap-1.5">
        <strong className="text-[.6875rem] tracking-wide text-muted-foreground uppercase">
          {label}
        </strong>
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <Button
              variant="outline"
              size="xs"
              key={item.id}
              type="button"
              title={item.sourceLabel}
              onClick={() => open(item)}
            >
              {item.title}
            </Button>
          ))}
        </div>
      </div>
    );

  return (
    <section className="search-panel" aria-labelledby="search-heading">
      <div className="source-page-heading">
        <p className="eyebrow">Permission-aware discovery</p>
        <h1 id="search-heading">Advanced search</h1>
        <p>Search every source you can access, then narrow the results.</p>
      </div>
      <form
        className="my-7 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex"
        role="search"
        onSubmit={submit}
      >
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            autoFocus
            className="h-11 bg-background pr-3 pl-10 shadow-none"
            type="search"
            value={query}
            maxLength={120}
            aria-label="Search company knowledge"
            placeholder="Search titles, content, owners, or tags…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
          <PopoverTrigger
            render={<Button variant="outline" className="h-11" />}
          >
            <SlidersHorizontal />
            Filters
            {activeFilters > 0 && (
              <Badge variant="secondary" className="ml-0.5 px-1.5">
                {activeFilters}
              </Badge>
            )}
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 gap-4 p-4">
            <PopoverHeader>
              <PopoverTitle>Filter knowledge</PopoverTitle>
              <PopoverDescription>
                Narrow results without crowding the search bar.
              </PopoverDescription>
            </PopoverHeader>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="search-type">Type</Label>
                <Select
                  value={type || "all"}
                  onValueChange={(value) =>
                    setType(value === "all" ? "" : value ?? "")}
                >
                  <SelectTrigger id="search-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    {result?.facets.types.map((item) => (
                      <SelectItem key={item} value={item}>{item}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="search-tag">Tag</Label>
                <Select
                  value={tag || "all"}
                  onValueChange={(value) =>
                    setTag(value === "all" ? "" : value ?? "")}
                >
                  <SelectTrigger id="search-tag" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All tags</SelectItem>
                    {result?.facets.tags.map((item) => (
                      <SelectItem key={item} value={item}>{item}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {result?.canIncludeArchived && (
              <Label className="rounded-lg border px-3 py-2.5">
                <Checkbox
                  checked={includeArchived}
                  onCheckedChange={(checked) =>
                    setIncludeArchived(checked === true)}
                />
                Include archived documents
              </Label>
            )}
            <div className="flex items-center justify-between border-t pt-3">
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled={!activeFilters}
                onClick={() => {
                  setType("");
                  setTag("");
                  setIncludeArchived(false);
                }}
              >
                <X /> Clear
              </Button>
              <Button
                size="sm"
                type="button"
                onClick={() => {
                  runSearch();
                  setFiltersOpen(false);
                }}
              >
                Apply filters
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <Button
          className="col-span-2 h-11 px-5 sm:w-auto"
          type="submit"
          disabled={busy}
        >
          {busy ? "Searching…" : "Search"}
        </Button>
      </form>
      {error && <p className="source-error" role="alert">{error}</p>}
      <div className="mb-2.5 text-xs text-muted-foreground" aria-live="polite">
        {busy ? "Checking access…" : `${result?.results.length ?? 0} results`}
      </div>
      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
        {result?.results.map((item) => {
          const detailCount = item.tags.length + item.links.length +
            item.backlinks.length;
          return (
            <article className="border-b last:border-b-0" key={item.id}>
              <div className="px-4 py-3.5">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <Button
                    variant="ghost"
                    type="button"
                    className="h-auto min-w-0 justify-start p-0 text-left text-[.95rem] font-semibold whitespace-normal hover:bg-transparent hover:text-primary"
                    onClick={() => open(item)}
                  >
                    {item.title}
                  </Button>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Badge variant="outline">{item.type}</Badge>
                    {item.trust !== "current" && (
                      <Badge variant="destructive">
                        {item.trust.replace("_", " ")}
                      </Badge>
                    )}
                    {item.status === "archived" && (
                      <Badge variant="secondary">Archived</Badge>
                    )}
                  </div>
                </div>
                {item.snippet && (
                  <p className="mt-1 line-clamp-2 text-[.8125rem] leading-5 text-muted-foreground">
                    {item.snippet}
                  </p>
                )}
                <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    {item.kind === "hub-native" ? "Workspace" : "Imported"}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate" title={item.sourceLabel}>
                    {item.sourceLabel}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="shrink-0">{item.owner}</span>
                </div>
              </div>
              {detailCount > 0 && (
                <details className="group border-t bg-muted/20 px-4 py-2 open:pb-3">
                  <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    Details · {detailCount}{" "}
                    {detailCount === 1 ? "item" : "items"}
                  </summary>
                  <div className="mt-3 grid gap-3">
                    {item.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {item.tags.map((itemTag) => (
                          <Badge variant="secondary" key={itemTag}>
                            {itemTag}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {relationships("Links to", item.links)}
                    {relationships("Linked from", item.backlinks)}
                  </div>
                </details>
              )}
            </article>
          );
        })}
        {!busy && result?.results.length === 0 && (
          <p className="p-10 text-center text-sm text-muted-foreground">
            No accessible knowledge matches these filters.
          </p>
        )}
      </div>
    </section>
  );
}

export function WorkTracePanel(
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
  const timeline = [
    ...(concept.activity ?? []).map((event) => ({
      type: "automatic" as const,
      timestamp: event.occurredAt,
      event,
    })),
    ...concept.workTraces.map((trace) => ({
      type: "context" as const,
      timestamp: trace.createdAt,
      trace,
    })),
  ].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const activityLabels: Record<string, string> = {
    "concept.created": "Document created",
    "concept.updated": "Document details updated",
    "concept.moved": "Document moved",
    "concept.published": "Document published",
    "concept.archived": "Document archived",
    "concept.restored": "Document restored",
    "concept.locked": "Editing locked",
    "concept.unlocked": "Editing unlocked",
    "concept.exported": "Markdown exported",
    "concept.draft.updated": "Draft updated through the API",
    "comment.created": "Comment thread started",
  };
  return (
    <section className="work-trace-panel" aria-labelledby="work-trace-heading">
      <header>
        <p className="eyebrow">Document activity</p>
        <h2 id="work-trace-heading">Activity</h2>
        <p>
          Important changes are captured automatically. Add context when the
          reason or outcome lives outside OKF.
        </p>
      </header>
      {canEdit && concept.status === "active" && (
        <details className="trace-create">
          <summary>Add context</summary>
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
              <Input
                name="occurredAt"
                type="date"
                defaultValue={today}
                required
              />
            </label>
            <label className="trace-title">
              Title
              <Input name="title" maxLength={100} required />
            </label>
            <label className="trace-summary">
              What happened and why
              <Textarea name="summary" rows={4} maxLength={4000} required />
            </label>
            <label className="trace-source">
              Ticket, PR, or source link <span>(optional)</span>
              <Input
                name="sourceUrl"
                type="url"
                maxLength={500}
                placeholder="https://github.com/company/project/issues/123"
              />
            </label>
            <Button
              variant="default"
              className="primary"
              type="submit"
              disabled={busy}
            >
              Add to activity
            </Button>
          </form>
        </details>
      )}
      <div className="work-trace-list">
        {timeline.map((item) => {
          if (item.type === "automatic") {
            const { event } = item;
            return (
              <article key={`${event.action}-${event.occurredAt}`}>
                <div className="trace-heading">
                  <span>Automatic</span>
                  <time dateTime={event.occurredAt}>
                    {new Date(event.occurredAt).toLocaleString()}
                  </time>
                </div>
                <h3>
                  {activityLabels[event.action] ??
                    event.action.replaceAll(".", " ")}
                </h3>
                <p className="trace-origin">
                  {event.actorName
                    ? `${event.actorName} · Captured by OKF`
                    : "Captured by OKF"}
                </p>
              </article>
            );
          }
          const { trace } = item;
          return (
            <article key={trace.id}>
              <div className="trace-heading">
                <span>Context · {trace.kind}</span>
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
                        <Textarea
                          name="knowledge"
                          rows={4}
                          maxLength={10000}
                          required
                        />
                      </label>
                      <Button type="submit" disabled={busy}>
                        Fold into document
                      </Button>
                    </form>
                  </details>
                )
                : null}
            </article>
          );
        })}
        {!timeline.length && (
          <p className="trace-empty">
            Activity will appear here as this document changes.
          </p>
        )}
      </div>
    </section>
  );
}

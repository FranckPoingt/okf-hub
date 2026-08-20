import {
  ArrowRight,
  Blocks,
  FilePlus2,
  FileText,
  Focus,
  GitBranch,
  Home,
  Link2,
  LoaderCircle,
  Presentation,
  Search,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { Concept, SearchResponse, SearchResult } from "../lib/models.ts";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "./ui/command.tsx";

export function CommandPalette({
  canEdit,
  concept,
  open,
  onCreate,
  onFocus,
  onOpenChange,
  onOpenConcept,
  onOpenHome,
  onOpenImported,
  onOpenReferences,
  onOpenSearch,
  onOpenSurface,
  onPresent,
}: {
  canEdit: boolean;
  concept: Concept | null;
  open: boolean;
  onCreate: () => void;
  onFocus: () => void;
  onOpenChange: (open: boolean) => void;
  onOpenConcept: (id: string) => void;
  onOpenHome: () => void;
  onOpenImported: (sourceId: string, path: string) => Promise<unknown>;
  onOpenReferences: () => void;
  onOpenSearch: () => void;
  onOpenSurface: (surface: "document" | "artifacts" | "activity") => void;
  onPresent: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)
      ) return;
      event.preventDefault();
      onOpenChange(!open);
    };
    globalThis.addEventListener("keydown", keydown);
    return () => globalThis.removeEventListener("keydown", keydown);
  }, [onOpenChange, open]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => {
      setSearchBusy(true);
      setSearchError("");
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      api(`/api/search?${params}`, { signal: controller.signal })
        .then(async (response) => {
          const body = await response.json() as SearchResponse & {
            error?: string;
          };
          if (!response.ok) throw new Error(body.error ?? "Search unavailable");
          setResults(body.results.slice(0, 8));
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") {
            return;
          }
          setSearchError(
            error instanceof Error ? error.message : "Search unavailable",
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearchBusy(false);
        });
    }, 150);
    return () => {
      globalThis.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);
  const changeOpen = (next: boolean) => {
    onOpenChange(next);
    if (!next) setQuery("");
  };
  const run = (action: () => void) => {
    changeOpen(false);
    action();
  };
  const openResult = (item: SearchResult) => {
    if (item.kind === "hub-native") return run(() => onOpenConcept(item.id));
    if (item.path) {
      run(() => void onOpenImported(item.sourceId, item.path!));
    }
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={changeOpen}
      title="Search company knowledge"
      description="Search every source you can access or run a command."
      className="sm:max-w-xl"
    >
      <Command shouldFilter={false}>
        <CommandInput
          autoFocus
          value={query}
          placeholder="Search company knowledge…"
          onValueChange={setQuery}
        />
        <CommandList className="max-h-[min(70vh,32rem)]">
          {!query.trim() && (
            <CommandGroup heading="Quick actions">
              <CommandItem onSelect={() => run(onOpenHome)}>
                <Home /> Home
              </CommandItem>
              {canEdit && (
                <CommandItem onSelect={() => run(onCreate)}>
                  <FilePlus2 /> New document
                </CommandItem>
              )}
            </CommandGroup>
          )}
          <CommandSeparator />
          <CommandGroup heading={query.trim() ? "Results" : "Knowledge"}>
            {searchBusy && (
              <CommandItem disabled>
                <LoaderCircle className="animate-spin" /> Searching…
              </CommandItem>
            )}
            {!searchBusy && !searchError && results.map((item) => (
              <CommandItem
                key={`${item.sourceId}-${item.id}`}
                onSelect={() => openResult(item)}
              >
                {item.kind === "hub-native" ? <FileText /> : <GitBranch />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.type} · {item.sourceLabel
                      .replace(/^https:\/\/github\.com\//, "")
                      .replace(/\.git$/, "")}
                  </span>
                </span>
              </CommandItem>
            ))}
            {!searchBusy && searchError && (
              <CommandItem disabled>{searchError}</CommandItem>
            )}
            {!searchBusy && !searchError && results.length === 0 && (
              <CommandEmpty>No accessible knowledge found.</CommandEmpty>
            )}
          </CommandGroup>
          {concept && (
            <>
              <CommandSeparator />
              <CommandGroup heading={concept.title}>
                <CommandItem
                  onSelect={() => run(() => onOpenSurface("document"))}
                >
                  <FileText /> Document
                </CommandItem>
                <CommandItem
                  onSelect={() => run(() => onOpenSurface("artifacts"))}
                >
                  <Blocks /> Apps
                </CommandItem>
                <CommandItem onSelect={() => run(onOpenReferences)}>
                  <Link2 /> References and backlinks
                </CommandItem>
                <CommandItem onSelect={() => run(onFocus)}>
                  <Focus /> Focus mode
                </CommandItem>
                <CommandItem onSelect={() => run(onPresent)}>
                  <Presentation /> Present
                </CommandItem>
              </CommandGroup>
            </>
          )}
          <CommandSeparator />
          <CommandGroup>
            <CommandItem onSelect={() => run(onOpenSearch)}>
              <Search /> Advanced search and filters
              <CommandShortcut>
                <ArrowRight />
              </CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

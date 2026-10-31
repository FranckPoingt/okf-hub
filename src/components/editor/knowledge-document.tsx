import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import type {
  SearchRelationship,
  SearchResponse,
  SearchResult,
} from "../../lib/models.ts";
import { parseAppRoute } from "../../routes.ts";
import { Button } from "../ui/button.tsx";
import { DocumentPreview } from "./document-editor.tsx";

export function KnowledgeDocument({
  documentId,
  markdown,
  conceptId,
  imported = false,
  onCommentOpen,
  onOpenHub,
  onOpenImported,
}: {
  documentId: string;
  markdown?: string;
  conceptId?: string;
  imported?: boolean;
  onCommentOpen?: (threadId: string) => void;
  onOpenHub: (id: string) => void;
  onOpenImported: (sourceId: string, path: string) => Promise<unknown>;
}) {
  const [state, setState] = useState<
    { documentId: string; result?: SearchResult; error?: string } | null
  >(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await api("/api/search", {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Relationships unavailable");
        const data = await response.json() as SearchResponse;
        if (!controller.signal.aborted) {
          setState({
            documentId,
            result: data.results.find((item) => item.id === documentId),
          });
        }
      } catch {
        if (!controller.signal.aborted) {
          setState({ documentId, error: "Relationships unavailable" });
        }
      }
    })();
    return () => controller.abort();
  }, [documentId, markdown]);
  const current = state?.documentId === documentId ? state : null;
  const open = (item: SearchRelationship) => {
    if (item.kind === "hub-native") onOpenHub(item.id);
    else if (item.path) void onOpenImported(item.sourceId, item.path);
  };
  const relationships = (label: string, items: SearchRelationship[] = []) =>
    items.length > 0 && (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <strong>{label}</strong>
        {items.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => open(item)}
          >
            {item.title} · {item.sourceLabel}
          </Button>
        ))}
      </div>
    );
  return (
    <>
      <aside className="my-4 grid gap-3" aria-label="Knowledge relationships">
        {current?.error && (
          <p className="text-sm text-muted-foreground" role="status">
            {current.error}
          </p>
        )}
        {Boolean(current?.result?.conflicts.length) && (
          <div
            className="rounded-md border border-amber-500 p-3 text-sm"
            role="status"
          >
            <strong>Potential definition conflict</strong>
            <p>
              Definitions differ across sources. Review the originals before
              deciding which applies.
            </p>
            {relationships("Compare with", current?.result?.conflicts)}
          </div>
        )}
        {relationships("Also defined in", current?.result?.alsoDefinedIn)}
        {Boolean(
          current?.result &&
            (current.result.links.length || current.result.backlinks.length),
        ) && (
          <details className="text-sm">
            <summary className="cursor-pointer">
              References and backlinks
            </summary>
            <div className="mt-2 grid gap-2">
              {relationships("Links to", current?.result?.links)}
              {relationships("Linked from", current?.result?.backlinks)}
            </div>
          </details>
        )}
      </aside>
      {markdown !== undefined && (current
        ? (
          <DocumentPreview
            markdown={markdown}
            conceptId={conceptId}
            imported={imported}
            linkTargets={current.result?.linkTargets}
            onCommentOpen={onCommentOpen}
            onLinkOpen={(href) => {
              const route = parseAppRoute(href.split("#", 1)[0]);
              if (route.kind === "concept") onOpenHub(route.id);
              else if (route.kind === "imported") {
                void onOpenImported(route.sourceId, route.path);
              } else return false;
              return true;
            }}
          />
        )
        : (
          <p className="text-sm text-muted-foreground" role="status">
            Loading knowledge…
          </p>
        ))}
    </>
  );
}

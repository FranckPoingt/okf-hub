import { MilkdownProvider } from "@milkdown/react";
import { GitCompareArrows } from "lucide-react";
import { useEffect, useState } from "react";
import { api, conceptPath } from "../../lib/api.ts";
import type { Revision } from "../../lib/models.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet.tsx";
import { RevisionDiff } from "./document-editor.tsx";

type RevisionBodies = Record<number, string>;

export function RevisionHistory({
  conceptId,
  revisions,
  open,
  canRestore,
  busy,
  onOpenChange,
  onRestore,
}: {
  conceptId: string;
  revisions: Revision[];
  open: boolean;
  canRestore: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onRestore: (number: number) => void;
}) {
  const [selectedNumber, setSelectedNumber] = useState<number>();
  const [bodies, setBodies] = useState<RevisionBodies | null>(null);
  const [error, setError] = useState("");
  const revisionKey = revisions.map((revision) => revision.number).join(",");
  const visibleRevisions = bodies
    ? revisions.filter((revision, index) =>
      index === revisions.length - 1 ||
      bodies[revision.number] !== bodies[revisions[index + 1].number]
    )
    : revisions;
  const hiddenCount = revisions.length - visibleRevisions.length;
  const selected =
    visibleRevisions.find((item) => item.number === selectedNumber) ??
      visibleRevisions[0];
  const selectedIndex = selected ? visibleRevisions.indexOf(selected) : -1;
  const previous = selectedIndex >= 0
    ? visibleRevisions[selectedIndex + 1]
    : undefined;
  const comparison = selected && bodies
    ? {
      after: bodies[selected.number],
      before: previous ? bodies[previous.number] : "",
    }
    : null;

  useEffect(() => {
    if (!open || revisions.length === 0) return;
    const controller = new AbortController();
    setBodies(null);
    setError("");
    void Promise.all(
      revisions.map(async (revision) => {
        const response = await api(
          `${conceptPath(conceptId)}/revisions/${revision.number}`,
          {
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error("Revision comparison unavailable");
        return [revision.number, await response.text()] as const;
      }),
    ).then((entries) => setBodies(Object.fromEntries(entries))).catch(
      (reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            reason instanceof Error ? reason.message : "Revision unavailable",
          );
        }
      },
    );
    return () => controller.abort();
  }, [conceptId, open, revisionKey]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        showOverlay={false}
        className="w-full gap-0 data-[side=right]:sm:max-w-3xl"
        aria-label="Revision history"
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="flex items-center gap-2">
            <GitCompareArrows className="size-4" />
            Revision history
          </SheetTitle>
          <SheetDescription>
            Select a published revision to see what changed.
          </SheetDescription>
        </SheetHeader>

        {revisions.length === 0
          ? (
            <p className="p-6 text-sm text-muted-foreground">
              Nothing has been published yet.
            </p>
          )
          : (
            <div className="grid min-h-0 flex-1 sm:grid-cols-[14rem_minmax(0,1fr)]">
              <nav
                className="flex gap-1 overflow-x-auto border-b p-3 sm:flex-col sm:overflow-y-auto sm:border-r sm:border-b-0"
                aria-label="Published revisions"
              >
                {visibleRevisions.map((revision, index) => (
                  <Button
                    key={revision.number}
                    type="button"
                    variant={revision.number === selected?.number
                      ? "secondary"
                      : "ghost"}
                    className="h-auto min-w-36 justify-start px-3 py-2 text-left sm:min-w-0"
                    onClick={() => setSelectedNumber(revision.number)}
                  >
                    <span className="grid gap-0.5">
                      <span className="flex items-center gap-2 font-medium">
                        Revision {revision.number}
                        {index === 0 && (
                          <Badge variant="secondary">Current content</Badge>
                        )}
                      </span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {new Date(revision.publishedAt).toLocaleString()}
                      </span>
                    </span>
                  </Button>
                ))}
                {hiddenCount > 0 && (
                  <p className="px-3 pt-2 text-xs text-muted-foreground">
                    {hiddenCount}{" "}
                    unchanged publish{hiddenCount === 1 ? "" : "es"} hidden
                  </p>
                )}
              </nav>

              <section className="min-h-0 overflow-y-auto p-5">
                <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-medium">
                      Changes in revision {selected?.number}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {previous
                        ? `Compared with revision ${previous.number}`
                        : "Initial published version"}
                    </p>
                  </div>
                  <div className="flex gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-emerald-500" />
                      {" "}
                      Added
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-red-400" />{" "}
                      Removed
                    </span>
                  </div>
                </div>
                {error
                  ? <p className="text-sm text-destructive">{error}</p>
                  : !comparison
                  ? (
                    <p className="text-sm text-muted-foreground">
                      Loading changes…
                    </p>
                  )
                  : comparison.before === comparison.after
                  ? (
                    <p className="text-sm text-muted-foreground">
                      No content changes.
                    </p>
                  )
                  : (
                    <div className="revision-diff">
                      <MilkdownProvider
                        key={`${selected?.number}-${previous?.number ?? 0}`}
                      >
                        <RevisionDiff
                          before={comparison.before}
                          after={comparison.after}
                        />
                      </MilkdownProvider>
                    </div>
                  )}
              </section>
            </div>
          )}

        {selected && (
          <SheetFooter className="flex-row items-center justify-end border-t">
            <Button
              type="button"
              disabled={!canRestore || busy}
              onClick={() => onRestore(selected.number)}
            >
              Restore revision {selected.number} as draft
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

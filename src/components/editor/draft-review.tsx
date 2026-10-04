import { MilkdownProvider } from "@milkdown/react";
import { FilePlus2, GitCompareArrows } from "lucide-react";
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

export function DraftReview({
  open,
  onOpenChange,
  onKeepEditing,
  publishedMarkdown,
  draftMarkdown,
  documentTitle,
  documentType,
  publishedMetadata,
  busy,
  canPublish,
  onPublish,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onKeepEditing: () => void;
  publishedMarkdown: string | null;
  draftMarkdown: string;
  documentTitle: string;
  documentType: string;
  publishedMetadata?: { title: string; type: string } | null;
  busy: boolean;
  canPublish: boolean;
  onPublish: () => void;
  error?: string;
}) {
  const before = publishedMarkdown ?? "";
  const hasChanges = before.trimEnd() !== draftMarkdown.trimEnd();
  const metadataChanges = publishedMetadata
    ? [
      { label: "Title", before: publishedMetadata.title, after: documentTitle },
      { label: "Type", before: publishedMetadata.type, after: documentType },
    ].filter((change) => change.before !== change.after)
    : [];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl"
        aria-label="Review unpublished changes"
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="flex items-center gap-2">
            <GitCompareArrows className="size-4" /> Review changes
          </SheetTitle>
          <SheetDescription>
            {publishedMarkdown === null
              ? `First publication of ${documentTitle}.`
              : `Draft changes to ${documentTitle} since its last published version.`}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {error && (
            <p className="mb-4 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          {metadataChanges.length > 0 && (
            <dl
              className="mb-5 grid gap-3 rounded-lg border p-4 text-sm"
              aria-label="Property changes"
            >
              {metadataChanges.map((change) => (
                <div key={change.label}>
                  <dt className="mb-1 font-medium">{change.label}</dt>
                  <dd className="flex flex-wrap items-center gap-2">
                    <del className="text-muted-foreground">{change.before}</del>
                    <span aria-hidden="true">→</span>
                    <span>{change.after}</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <div
            className="mb-5 flex gap-4 text-xs text-muted-foreground"
            aria-label="Change legend"
          >
            <span className="flex items-center gap-1.5">
              <span
                className="size-2 rounded-full bg-emerald-500"
                aria-hidden="true"
              />{" "}
              Added
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="size-2 rounded-full bg-red-400"
                aria-hidden="true"
              />{" "}
              Removed
            </span>
          </div>
          {open && hasChanges
            ? (
              <div className="revision-diff">
                <MilkdownProvider>
                  <RevisionDiff before={before} after={draftMarkdown} />
                </MilkdownProvider>
              </div>
            )
            : (
              <p className="text-sm text-muted-foreground">
                No document body changes. Updated properties will be included
                when you publish.
              </p>
            )}
        </div>
        <SheetFooter className="flex-row items-center justify-between border-t">
          <Button
            type="button"
            variant="outline"
            onClick={onKeepEditing}
          >
            Keep editing
          </Button>
          <Button
            type="button"
            disabled={!canPublish || busy}
            onClick={onPublish}
          >
            <FilePlus2 /> {busy ? "Publishing…" : "Publish draft"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

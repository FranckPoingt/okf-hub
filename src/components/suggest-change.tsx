import { useEffect, useState } from "react";
import { MilkdownProvider } from "@milkdown/react";
import { api } from "../lib/api.ts";
import {
  LocalMarkdownEditor,
  RevisionDiff,
} from "./editor/document-editor.tsx";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import { Textarea } from "./ui/textarea.tsx";

type Status = {
  mode: "pull-request" | "patch" | null;
  canPropose: boolean;
  openCount: number;
  proposals: { prUrl: string; status: string }[];
};

export function SuggestChange(
  { sourceId, path, markdown, revision }: {
    sourceId: string;
    path: string;
    markdown: string;
    revision: string;
  },
) {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [edited, setEdited] = useState(markdown);
  const [review, setReview] = useState(false);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endpoint = `/api/sources/repositories/${sourceId}/change-proposals`;
  const load = () =>
    api(`${endpoint}?path=${encodeURIComponent(path)}`).then(async (response) =>
      response.ok ? setStatus(await response.json()) : setStatus(null)
    ).catch(() => setStatus(null));
  useEffect(() => {
    void load();
  }, [endpoint, path]);
  function close() {
    setOpen(false);
    setReview(false);
    setRationale("");
    setError("");
    setEdited(markdown);
  }
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const response = await api(endpoint, {
        method: "POST",
        body: JSON.stringify({
          path,
          baseRevision: revision,
          body: edited,
          rationale,
        }),
      });
      if (!response.ok) {
        throw new Error((await response.json()).error ?? "Suggestion failed");
      }
      if (status?.mode === "patch") {
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = "okf-suggestion.patch";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        globalThis.open((await response.json()).url, "_blank", "noreferrer");
      }
      close();
      void load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Suggestion failed");
    } finally {
      setBusy(false);
    }
  }
  if (!status) return null;
  const pending = status.proposals.filter((item) => item.status === "open");
  return (
    <>
      {status.canPropose && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setOpen(true)}
        >
          Suggest a change
        </Button>
      )}
      {pending.length > 0 && (
        <span>
          {pending.length} open suggestion{pending.length > 1 ? "s" : ""}{" "}
          {pending.map((item, index) => (
            <a
              key={item.prUrl}
              href={item.prUrl}
              target="_blank"
              rel="noreferrer"
            >
              {index ? ", " : "("}view{index === pending.length - 1 ? ")" : ""}
            </a>
          ))}
        </span>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !busy) close();
        }}
      >
        <DialogContent className="sm:max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Suggest a change</DialogTitle>
            <DialogDescription>
              {status.mode === "patch"
                ? "Edit the text, then download a patch to share with the repository's maintainers."
                : "Edit the text. Submitting opens a draft pull request for the repository's maintainers; this page does not change until it is merged and the source syncs."}
            </DialogDescription>
          </DialogHeader>
          {review
            ? (
              <>
                <MilkdownProvider key="diff">
                  <RevisionDiff before={markdown} after={edited} />
                </MilkdownProvider>
                <label className="space-y-1">
                  <span>Why are you suggesting this?</span>
                  <Textarea
                    value={rationale}
                    maxLength={1000}
                    onChange={(event) => setRationale(event.target.value)}
                  />
                </label>
                {error && <p role="alert">{error}</p>}
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => setReview(false)}
                  >
                    Back to editing
                  </Button>
                  <Button
                    disabled={busy || !rationale.trim()}
                    onClick={() => void submit()}
                  >
                    {busy
                      ? "Working…"
                      : status.mode === "patch"
                      ? "Download patch"
                      : "Open draft pull request"}
                  </Button>
                </div>
              </>
            )
            : (
              <>
                <MilkdownProvider key="edit">
                  <LocalMarkdownEditor value={edited} onChange={setEdited} />
                </MilkdownProvider>
                <Button
                  disabled={edited.trim() === markdown.trim()}
                  onClick={() => setReview(true)}
                >
                  Review changes
                </Button>
              </>
            )}
        </DialogContent>
      </Dialog>
    </>
  );
}

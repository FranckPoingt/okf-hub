import { useEffect, useState } from "react";
import { Crepe } from "@milkdown/crepe";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { api } from "../lib/api.ts";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";

type Draft = {
  draftId: string;
  files: { path: string; markdown: string }[];
  dropped: number;
};
function Preview({ markdown }: { markdown: string }) {
  useEditor((root) => {
    const crepe = new Crepe({
      root,
      defaultValue: markdown,
      features: { [Crepe.Feature.AI]: false, [Crepe.Feature.TopBar]: false },
    });
    crepe.setReadonly(true);
    return crepe;
  }, []);
  return <Milkdown />;
}

export function OkfDraftPanel(
  { sourceId, github }: { sourceId: string; github: boolean },
) {
  const [available, setAvailable] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pr, setPr] = useState("");
  const endpoint = `/api/sources/repositories/${sourceId}/okf-draft`;
  useEffect(() => {
    let active = true;
    api(endpoint).then(async (response) => {
      if (response.ok && active) {
        setAvailable((await response.json()).available);
      }
    }).catch(() => {});
    return () => {
      active = false;
    };
  }, [endpoint]);
  async function run(approve = false) {
    setBusy(true);
    setError("");
    try {
      const response = await api(endpoint + (approve ? "/approve" : ""), {
        method: "POST",
        body: JSON.stringify(approve ? { draftId: draft?.draftId } : {}),
      });
      if (!response.ok) {
        throw new Error((await response.json()).error ?? "Draft failed");
      }
      if (approve && !github) {
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = "okf-draft.zip";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setDraft(null);
      } else {
        const result = await response.json();
        if (approve) {
          setPr(result.url);
          setDraft(null);
        } else {
          setDraft(result);
          setSelected(0);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Draft failed");
    } finally {
      setBusy(false);
    }
  }
  if (!available) return null;
  return (
    <section className="space-y-3">
      <Button variant="outline" disabled={busy} onClick={() => void run()}>
        {busy ? "Working…" : "Draft an OKF bundle"}
      </Button>
      <p className="text-sm text-muted-foreground">
        Sends selected repository documentation to the configured AI provider.
        Review the proposal before sharing it.
      </p>
      {pr && (
        <a href={pr} target="_blank" rel="noreferrer">Review pull request</a>
      )}
      {error && <p role="alert">{error}</p>}
      <Dialog
        open={Boolean(draft)}
        onOpenChange={(open) => {
          if (!open && !busy) setDraft(null);
        }}
      >
        <DialogContent className="sm:max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Review draft OKF bundle</DialogTitle>
            <DialogDescription>
              AI-drafted knowledge. Check every claim and source. Approval{" "}
              {github
                ? "opens a draft pull request for repository review"
                : "downloads a ZIP"}.
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <>
              {draft.dropped > 0 && (
                <p>{draft.dropped} invalid concepts were dropped.</p>
              )}
              <nav aria-label="Draft files" className="flex flex-wrap gap-2">
                {draft.files.map((file, index) => (
                  <Button
                    key={file.path}
                    variant={selected === index ? "default" : "outline"}
                    onClick={() => setSelected(index)}
                  >
                    {file.path}
                  </Button>
                ))}
              </nav>
              <details>
                <summary>Markdown and provenance</summary>
                <pre className="whitespace-pre-wrap text-sm">{draft.files[selected].markdown}</pre>
              </details>
              <MilkdownProvider key={`${draft.draftId}-${selected}`}>
                <Preview
                  markdown={draft.files[selected].markdown.replace(
                    /^---\n[\s\S]*?\n---\n/,
                    "",
                  )}
                />
              </MilkdownProvider>
              <Button disabled={busy} onClick={() => void run(true)}>
                {busy
                  ? "Working…"
                  : github
                  ? "Approve and open pull request"
                  : "Approve and download ZIP"}
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

import { useState } from "react";
import { api } from "../lib/api.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";

export function ArtifactUpload(
  { spaceId, onCreated }: { spaceId: string; onCreated: (id: string) => void },
) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [needsContext, setNeedsContext] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function upload() {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("Upload exceeds 8 MiB");
      const params = new URLSearchParams({
        spaceId,
        name: file.name,
        title,
        description,
      });
      const response = await api(`/api/artifact-uploads?${params}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Upload failed");
      if (result.needsContext) {
        setNeedsContext(true);
        return;
      }
      setOpen(false);
      onCreated(result.documentId);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setOpen(true);
          setError("");
          setFile(null);
          setNeedsContext(false);
          setTitle("");
          setDescription("");
        }}
      >
        Upload artifact
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload artifact</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Choose one HTML file or a ZIP with index.html at its root. Files
            must work offline. The Artifact will be saved as a draft.
          </p>
          <Input
            aria-label="Artifact file"
            type="file"
            accept=".html,.zip"
            disabled={busy}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setNeedsContext(false);
              setError("");
            }}
          />
          {needsContext && (
            <>
              <p className="text-sm">
                This artifact has no context.md. Add a title and description to
                explain it.
              </p>
              <label>
                Title<Input
                  value={title}
                  maxLength={100}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label>
                Description<Input
                  value={description}
                  maxLength={240}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}{" "}
              For CDN dependencies, use artifact:save &lt;dir&gt; --vendor with
              the CLI.
            </p>
          )}
          <Button
            disabled={busy || !file ||
              (needsContext && (!title.trim() || !description.trim()))}
            onClick={() => void upload()}
          >
            {busy ? "Uploading…" : "Save draft artifact"}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}

import { SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, conceptPath } from "../../lib/api.ts";
import { Alert, AlertDescription } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Label } from "../ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select.tsx";
import { Textarea } from "../ui/textarea.tsx";

type DocumentIntent = "canonical" | "working" | "evidence" | "ephemeral";

export type DocumentPropertiesConcept = {
  id: string;
  intent: DocumentIntent;
  space: string;
  spaceId: string;
  title: string;
  type: string;
};

type MetadataPatch = Partial<
  Pick<DocumentPropertiesConcept, "intent" | "spaceId" | "title" | "type">
>;

type DocumentPropertiesProps = {
  canEdit: boolean;
  concept: DocumentPropertiesConcept;
  spaces: Array<{ id: string; name: string }>;
  onConceptUpdate: (updated: DocumentPropertiesConcept) => void;
  onSaveReady?: (flush: (() => Promise<void>) | null) => void;
};

const documentTypes = [
  "Document",
  "Explanation",
  "Policy",
  "Guide",
  "Specification",
  "Architecture",
  "SOP",
  "Plan",
  "Note",
];

export function DocumentProperties({
  canEdit,
  concept,
  spaces,
  onConceptUpdate,
  onSaveReady,
}: DocumentPropertiesProps) {
  const typeOptions = documentTypes.includes(concept.type)
    ? documentTypes
    : [concept.type, ...documentTypes];
  const [title, setTitle] = useState(concept.title);
  const titleValue = useRef(title);
  titleValue.current = title;
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [failedPatch, setFailedPatch] = useState<MetadataPatch | null>(null);
  const latest = useRef(concept);
  const requests = useRef(Promise.resolve());
  const pending = useRef(0);
  const desired = useRef<MetadataPatch>({});
  const saveError = useRef<Error | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (pending.current === 0) latest.current = concept;
  }, [concept]);
  useEffect(() => setTitle(concept.title), [concept.title]);
  useEffect(() => {
    if (!canEdit) return;
    const protectProperties = (event: BeforeUnloadEvent) => {
      if (
        !pending.current && !Object.keys(desired.current).length &&
        titleValue.current.trim() === latest.current.title
      ) return;
      event.preventDefault();
      event.returnValue = "";
    };
    globalThis.addEventListener("beforeunload", protectProperties);
    return () =>
      globalThis.removeEventListener("beforeunload", protectProperties);
  }, [canEdit]);

  const saveMetadata = (patch: MetadataPatch) => {
    if (!canEdit) return;
    desired.current = { ...desired.current, ...patch };
    pending.current += 1;
    setBusy(true);
    setError("");
    setFailedPatch(null);
    requests.current = requests.current.then(async () => {
      try {
        const current = latest.current;
        const currentPatch = { ...desired.current };
        if (!Object.keys(currentPatch).length) return;
        const response = await api(`${conceptPath(current.id)}/metadata`, {
          method: "PUT",
          body: JSON.stringify(currentPatch),
        });
        const updated = await response.json() as DocumentPropertiesConcept & {
          error?: string;
        };
        if (!response.ok) {
          throw new Error(updated.error ?? "Could not update document");
        }
        latest.current = updated;
        for (
          const key of Object.keys(currentPatch) as Array<keyof MetadataPatch>
        ) {
          if (desired.current[key] === currentPatch[key]) {
            delete desired.current[key];
          }
        }
        saveError.current = null;
        if (mounted.current) {
          setError("");
          setFailedPatch(null);
          onConceptUpdate(updated);
        }
      } catch (cause) {
        saveError.current = cause instanceof Error
          ? cause
          : new Error("Could not update document");
        if (mounted.current) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not update document",
          );
          setFailedPatch({ ...desired.current });
        }
      } finally {
        pending.current -= 1;
        if (mounted.current) setBusy(pending.current > 0);
      }
    });
  };

  useEffect(() => {
    onSaveReady?.(async () => {
      const nextTitle = titleValue.current.trim();
      if (!nextTitle) {
        throw new Error("A document title is required.");
      }
      if (canEdit && nextTitle !== latest.current.title) {
        saveMetadata({ title: nextTitle });
      } else if (!pending.current) {
        delete desired.current.title;
        if (!Object.keys(desired.current).length) {
          saveError.current = null;
          setError("");
          setFailedPatch(null);
        }
      }
      await requests.current;
      if (saveError.current) throw saveError.current;
    });
    return () => onSaveReady?.(null);
  }, [canEdit, onSaveReady]);

  const saveTitle = () => {
    const nextTitle = title.trim();
    if (!nextTitle) {
      saveError.current = new Error("A document title is required.");
      setError(saveError.current.message);
      return;
    }
    if (nextTitle === latest.current.title) {
      if (!Object.keys(desired.current).length) {
        saveError.current = null;
        setError("");
      }
      return;
    }
    saveMetadata({ title: nextTitle });
  };

  const changeType = (type: string) => {
    saveMetadata({ type });
  };

  const changeIntent = (intent: DocumentIntent) => {
    saveMetadata({ intent });
  };

  return (
    <header className="canvas-header">
      <Textarea
        className="canvas-title-input"
        value={title}
        disabled={!canEdit || busy}
        maxLength={100}
        aria-label="Document title"
        rows={1}
        onChange={(event) =>
          setTitle(event.target.value.replace(/\r?\n/g, " "))}
        onBlur={saveTitle}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        placeholder="Untitled"
      />

      <div className="document-property-summary">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={propertiesOpen}
          onClick={() => setPropertiesOpen((open) => !open)}
        >
          <SlidersHorizontal />
          Properties
        </Button>
        {busy && (
          <span className="text-xs text-muted-foreground" role="status">
            Saving properties…
          </span>
        )}
      </div>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{error}</span>
            {failedPatch && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => saveMetadata(failedPatch)}
              >
                Retry
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {propertiesOpen && (
        <div className="frontmatter-block">
          <div className="frontmatter-row">
            <Label htmlFor="document-space">Space</Label>
            {canEdit
              ? (
                <Select
                  value={concept.spaceId}
                  disabled={busy}
                  onValueChange={(value) =>
                    value && saveMetadata({ spaceId: value })}
                >
                  <SelectTrigger
                    id="document-space"
                    className="w-full max-w-52"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {spaces.map((space) => (
                      <SelectItem key={space.id} value={space.id}>
                        {space.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
              : <span>{concept.space}</span>}
          </div>

          <div className="frontmatter-row">
            <Label htmlFor="document-type">Type</Label>
            {canEdit
              ? (
                <Select
                  value={concept.type}
                  disabled={busy}
                  onValueChange={(value) => value && changeType(value)}
                >
                  <SelectTrigger id="document-type" className="w-full max-w-52">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {typeOptions.map((type) => (
                      <SelectItem key={type} value={type}>{type}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
              : <span>{concept.type}</span>}
          </div>

          <div className="frontmatter-row">
            <Label htmlFor="document-intent">Intent</Label>
            {canEdit
              ? (
                <Select
                  value={concept.intent}
                  disabled={busy}
                  onValueChange={(value) =>
                    value && changeIntent(value as DocumentIntent)}
                >
                  <SelectTrigger
                    id="document-intent"
                    className="w-full max-w-52"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="canonical">
                      Maintained knowledge
                    </SelectItem>
                    <SelectItem value="working">Working document</SelectItem>
                    <SelectItem value="evidence">Evidence</SelectItem>
                    <SelectItem value="ephemeral">Ephemeral notes</SelectItem>
                  </SelectContent>
                </Select>
              )
              : <span className="capitalize">{concept.intent}</span>}
          </div>
        </div>
      )}
    </header>
  );
}

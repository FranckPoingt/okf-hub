import { SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
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

type DocumentPropertiesProps = {
  canEdit: boolean;
  concept: DocumentPropertiesConcept;
  spaces: Array<{ id: string; name: string }>;
  onConceptUpdate: (updated: DocumentPropertiesConcept) => void;
};

const documentTypes = [
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
}: DocumentPropertiesProps) {
  const [title, setTitle] = useState(concept.title);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => setTitle(concept.title), [concept.title]);

  const saveMetadata = async (
    patch: Partial<
      Pick<DocumentPropertiesConcept, "intent" | "spaceId" | "title" | "type">
    >,
  ) => {
    setError("");
    try {
      const response = await api(`${conceptPath(concept.id)}/metadata`, {
        method: "PUT",
        body: JSON.stringify({
          title: concept.title,
          type: concept.type,
          intent: concept.intent,
          spaceId: concept.spaceId,
          ...patch,
        }),
      });
      const updated = await response.json() as DocumentPropertiesConcept & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(updated.error ?? "Could not update document");
      }
      onConceptUpdate(updated);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update document",
      );
    }
  };

  const saveTitle = () => {
    const nextTitle = title.trim();
    if (!nextTitle || nextTitle === concept.title) {
      setTitle(concept.title);
      return;
    }
    void saveMetadata({ title: nextTitle });
  };

  const changeType = (type: string) => {
    void saveMetadata({ type });
  };

  const changeIntent = (intent: DocumentIntent) => {
    void saveMetadata({ intent });
  };

  return (
    <header className="canvas-header">
      <Textarea
        className="canvas-title-input"
        value={title}
        disabled={!canEdit}
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
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
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
                  onValueChange={(value) =>
                    value && void saveMetadata({ spaceId: value })}
                >
                  <SelectTrigger id="document-space" className="w-52">
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
                  onValueChange={(value) => value && changeType(value)}
                >
                  <SelectTrigger id="document-type" className="w-52">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {documentTypes.map((type) => (
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
                  onValueChange={(value) =>
                    value && changeIntent(value as DocumentIntent)}
                >
                  <SelectTrigger id="document-intent" className="w-52">
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

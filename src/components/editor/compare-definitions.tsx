import { useState } from "react";
import { api } from "../../lib/api.ts";
import type { SearchResult } from "../../lib/models.ts";
import { Button } from "../ui/button.tsx";

export function CompareDefinitions({ current }: { current?: SearchResult }) {
  const [result, setResult] = useState<{ id: string; text: string }>();
  const [busy, setBusy] = useState(false);
  if (!current?.canCompareDefinitions) return null;
  const compare = async (rightId: string) => {
    setBusy(true);
    const id = current.id;
    try {
      const response = await api("/api/knowledge/compare", {
        method: "POST",
        body: JSON.stringify({ leftId: id, rightId }),
      });
      const body = await response.json();
      setResult({
        id,
        text: response.ok
          ? `${body.answer}${
            body.truncated ? "\nBased on shortened definitions." : ""
          }`
          : body.error ?? "Comparison failed",
      });
    } catch {
      setResult({ id, text: "Comparison unavailable" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-2 text-sm">
      {current.alsoDefinedIn.map((peer) => (
        <Button
          key={peer.id}
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void compare(peer.id)}
        >
          Compare definitions · {peer.sourceLabel}
        </Button>
      ))}
      {busy && <p role="status">Comparing definitions…</p>}
      {result?.id === current.id && (
        <div className="whitespace-pre-wrap" role="status">
          <p className="text-muted-foreground">
            AI comparison · Review the original definitions.
          </p>
          {result.text}
        </div>
      )}
    </div>
  );
}

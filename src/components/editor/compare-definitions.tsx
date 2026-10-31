import { useState } from "react";
import { api } from "../../lib/api.ts";
import type { SearchResult } from "../../lib/models.ts";
import { Button } from "../ui/button.tsx";

export function CompareDefinitions(
  { current, onOpenSettings }: {
    current?: SearchResult;
    onOpenSettings?: () => void;
  },
) {
  const [result, setResult] = useState<
    { id: string; text: string; failed?: boolean }
  >();
  const [busy, setBusy] = useState(false);
  if (!current?.canCompareDefinitions || !current.alsoDefinedIn.length) {
    return null;
  }
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
        failed: !response.ok,
      });
    } catch {
      setResult({ id, text: "Comparison unavailable", failed: true });
    } finally {
      setBusy(false);
    }
  };
  if (!current.aiEnabled) {
    return (
      <div className="grid gap-2 text-sm">
        <Button variant="outline" size="sm" disabled>
          Compare definitions
        </Button>
        <p className="text-muted-foreground">
          Connect an AI provider to compare definitions.
        </p>
        {onOpenSettings && (
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={onOpenSettings}
          >
            Open AI settings
          </Button>
        )}
      </div>
    );
  }
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
          {!result.failed && (
            <p className="text-muted-foreground">
              AI comparison · Review the original definitions.
            </p>
          )}
          {result.text}
        </div>
      )}
    </div>
  );
}

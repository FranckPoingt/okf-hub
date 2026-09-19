import { type FormEvent, useEffect, useState } from "react";
import { Bot, Send, Sparkles } from "lucide-react";
import { api } from "../lib/api.ts";
import type { AIConfig } from "../lib/models.ts";
import { Button } from "./ui/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "./ui/sheet.tsx";
import { Textarea } from "./ui/textarea.tsx";

type Message = { role: "user" | "assistant"; content: string };
type AskTarget =
  | { kind: "concept"; conceptId: string; state: "draft" | "published" }
  | { kind: "imported"; importId: string; state: "source" };

export function AskOKF({
  open,
  onOpenChange,
  target,
  documentTitle,
  config,
  onOpenSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: AskTarget;
  documentTitle: string;
  config: AIConfig;
  onOpenSettings: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setMessages([]);
    setQuestion("");
    setError("");
  }, [target.kind === "concept" ? target.conceptId : target.importId]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = question.trim();
    if (!content || busy) return;
    const next = [...messages, { role: "user" as const, content }];
    setMessages(next);
    setQuestion("");
    setError("");
    setBusy(true);
    try {
      const response = await api("/api/ai/chat", {
        method: "POST",
        body: JSON.stringify({
          ...(target.kind === "concept"
            ? { conceptId: target.conceptId, state: target.state }
            : { importId: target.importId }),
          messages: next.slice(-12),
        }),
      });
      const result = await response.json() as {
        message?: string;
        error?: string;
      };
      if (!response.ok || !result.message) {
        throw new Error(result.error ?? "Ask OKF could not answer");
      }
      setMessages((current) => [...current, {
        role: "assistant",
        content: result.message!,
      }]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ask OKF failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        showOverlay={false}
        className="w-full gap-0 sm:max-w-md"
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="size-4" /> Ask OKF
          </SheetTitle>
          <SheetDescription>
            Answers from {documentTitle} · {target.state}
          </SheetDescription>
        </SheetHeader>

        {!config.enabled
          ? (
            <div className="grid flex-1 place-content-center gap-3 p-6 text-center">
              <Bot className="mx-auto size-8 text-muted-foreground" />
              <strong>Connect an AI provider first</strong>
              <p className="text-sm text-muted-foreground">
                Provider credentials stay on the OKF server.
              </p>
              <Button type="button" onClick={onOpenSettings}>
                Open AI settings
              </Button>
            </div>
          )
          : (
            <>
              <ol
                className="flex flex-1 flex-col gap-3 overflow-y-auto p-4"
                aria-live="polite"
              >
                {!messages.length && (
                  <li className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    Ask a question about this document. Ask OKF can explain what
                    is present, but cannot edit or run anything.
                  </li>
                )}
                {messages.map((message, index) => (
                  <li
                    key={`${message.role}-${index}`}
                    className={message.role === "user"
                      ? "ml-8 rounded-lg bg-primary p-3 text-primary-foreground"
                      : "mr-8 whitespace-pre-wrap rounded-lg bg-muted p-3"}
                  >
                    <span className="sr-only">
                      {message.role === "user" ? "You" : "Ask OKF"}:
                    </span>
                    {message.content}
                  </li>
                ))}
                {busy && (
                  <li className="mr-8 rounded-lg bg-muted p-3 text-muted-foreground">
                    Reading the document…
                  </li>
                )}
                {error && <li className="form-error" role="alert">{error}</li>}
              </ol>
              <SheetFooter className="border-t">
                <form className="grid gap-2" onSubmit={submit}>
                  <Textarea
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    placeholder="Ask about this document"
                    maxLength={4_000}
                    rows={3}
                    disabled={busy}
                    aria-label="Question for Ask OKF"
                  />
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-muted-foreground">
                      {config.provider} · {config.model}
                    </span>
                    <Button type="submit" disabled={busy || !question.trim()}>
                      <Send /> Ask
                    </Button>
                  </div>
                </form>
              </SheetFooter>
            </>
          )}
      </SheetContent>
    </Sheet>
  );
}

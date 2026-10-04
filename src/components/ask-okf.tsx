import { type FormEvent, useEffect, useRef, useState } from "react";
import { Bot, RotateCcw, Send, Sparkles, Square } from "lucide-react";
import { api } from "../lib/api.ts";
import type { AIConfig } from "../lib/models.ts";
import { AnswerMarkdown } from "./answer-markdown.tsx";
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

type Message = {
  role: "user" | "assistant";
  content: string;
  version?: string;
};
export type AskSession = {
  messages: Message[];
  question: string;
  error: string;
  retryQuestion?: string;
};
type AskTarget =
  | { kind: "concept"; conceptId: string; state: "draft" | "published" }
  | { kind: "imported"; importId: string; state: "source" };
const emptySession = (): AskSession => ({
  messages: [],
  question: "",
  error: "",
});
const suggestions = [
  "Summarise the key points",
  "Explain this to a new teammate",
  "What is unclear or missing?",
];

export function AskOKF({
  open,
  onOpenChange,
  target,
  documentTitle,
  documentHref,
  documentVersion,
  documentReady = true,
  config,
  sessions,
  onOpenSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: AskTarget;
  documentTitle: string;
  documentHref: string;
  documentVersion: string;
  documentReady?: boolean;
  config: AIConfig;
  sessions?: Map<string, AskSession>;
  onOpenSettings: () => void;
}) {
  const localSessions = useRef(new Map<string, AskSession>());
  const cache = sessions ?? localSessions.current;
  const targetKey = target.kind === "concept"
    ? `${target.kind}:${target.conceptId}:${target.state}`
    : `${target.kind}:${target.importId}`;
  const [session, setSession] = useState(() => ({
    key: targetKey,
    ...(cache.get(targetKey) ?? emptySession()),
  }));
  const current = session.key === targetKey
    ? session
    : cache.get(targetKey) ?? emptySession();
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const pending = useRef<
    {
      key: string;
      before: AskSession;
      content: string;
    } | null
  >(null);
  const conversation = useRef<HTMLOListElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setSession({ key: targetKey, ...(cache.get(targetKey) ?? emptySession()) });
    setBusy(false);
    return () => {
      request.current?.abort();
      request.current = null;
      if (pending.current) {
        const { key, before, content } = pending.current;
        cache.set(key, { ...before, question: content });
        pending.current = null;
      }
    };
  }, [cache, targetKey]);

  useEffect(() => {
    if (session.key === targetKey) cache.set(session.key, session);
  }, [cache, session, targetKey]);

  useEffect(() => {
    if (!pending.current) return;
    request.current?.abort();
    request.current = null;
    const { before, content } = pending.current;
    pending.current = null;
    setSession({
      key: targetKey,
      ...before,
      question: content,
      error:
        "The document changed. Send your question again to use its latest content.",
      retryQuestion: content,
    });
    setBusy(false);
  }, [documentReady, documentVersion, targetKey]);

  useEffect(() => {
    if (open && conversation.current) {
      conversation.current.scrollTo({
        top: conversation.current.scrollHeight,
        behavior:
          globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
      });
    }
  }, [busy, current.messages.length, current.error, open, targetKey]);

  const stop = () => {
    request.current?.abort();
    request.current = null;
    if (pending.current) {
      const { before, content } = pending.current;
      pending.current = null;
      setSession({
        key: targetKey,
        ...before,
        question: content,
        error: "Stopped. Your question is ready to send again.",
        retryQuestion: content,
      });
    }
    setBusy(false);
  };

  const ask = async (question: string) => {
    const content = question.trim();
    if (
      !content || busy || request.current || !config.enabled || !documentReady
    ) return;
    const before: AskSession = current;
    const next = [...before.messages, { role: "user" as const, content }];
    setSession({ key: targetKey, messages: next, question: "", error: "" });
    setBusy(true);
    const controller = new AbortController();
    request.current = controller;
    pending.current = { key: targetKey, before, content };
    try {
      const response = await api("/api/ai/chat", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          ...(target.kind === "concept"
            ? { conceptId: target.conceptId, state: target.state }
            : { importId: target.importId }),
          messages: next.slice(-12).map(({ role, content }) => ({
            role,
            content,
          })),
        }),
      });
      const result = await response.json() as {
        message?: string;
        error?: string;
      };
      if (request.current !== controller) return;
      if (!response.ok || !result.message) {
        throw new Error(result.error ?? "Ask OKF could not answer");
      }
      setSession({
        key: targetKey,
        messages: [...next, {
          role: "assistant",
          content: result.message,
          version: documentVersion,
        }],
        question: "",
        error: "",
      });
    } catch (cause) {
      if (request.current !== controller) return;
      setSession({
        key: targetKey,
        ...before,
        question: content,
        error: cause instanceof Error ? cause.message : "Ask OKF failed",
        retryQuestion: content,
      });
    } finally {
      if (request.current === controller) {
        request.current = null;
        pending.current = null;
        setBusy(false);
      }
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void ask(current.question);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) stop();
        onOpenChange(next);
      }}
      modal={false}
    >
      <SheetContent
        showOverlay={false}
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg"
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="size-4" /> Ask OKF
          </SheetTitle>
          <SheetDescription>
            Answers from {documentTitle} · {documentVersion}
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
              <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
                <p className="text-xs text-muted-foreground">
                  This document only · Read-only
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy || !current.messages.length}
                  onClick={() =>
                    setSession({ key: targetKey, ...emptySession() })}
                >
                  <RotateCcw /> New chat
                </Button>
              </div>
              <ol
                ref={conversation}
                className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
                role="log"
                aria-label="Ask OKF conversation"
                aria-live="polite"
                aria-busy={busy}
              >
                {!current.messages.length && !busy && (
                  <li className="grid gap-3 rounded-lg border border-dashed p-4">
                    <p className="text-sm text-muted-foreground">
                      Ask OKF explains this document using the version shown
                      above. Your conversation stays in this browser tab until
                      you sign out or reload.
                    </p>
                    <div className="grid gap-2">
                      {suggestions.map((suggestion) => (
                        <Button
                          key={suggestion}
                          type="button"
                          variant="outline"
                          className="h-auto justify-start whitespace-normal py-2 text-left"
                          disabled={!documentReady}
                          onClick={() => {
                            setSession({
                              key: targetKey,
                              ...current,
                              question: suggestion,
                              error: "",
                            });
                            input.current?.focus();
                          }}
                        >
                          {suggestion}
                        </Button>
                      ))}
                    </div>
                  </li>
                )}
                {current.messages.map((message, index) => (
                  <li
                    key={`${message.role}-${index}`}
                    className={message.role === "user"
                      ? "ml-8 whitespace-pre-wrap break-words rounded-lg bg-primary p-3 text-primary-foreground"
                      : "mr-4 min-w-0 rounded-lg bg-muted p-3"}
                  >
                    <span className="sr-only">
                      {message.role === "user" ? "You" : "Ask OKF"}:
                    </span>
                    {message.role === "user" ? message.content : (
                      <>
                        <AnswerMarkdown content={message.content} />
                        <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">
                          Based on{" "}
                          <a
                            href={documentHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline underline-offset-2"
                          >
                            {documentTitle}
                          </a>{" "}
                          · {message.version}
                        </p>
                      </>
                    )}
                  </li>
                ))}
                {busy && (
                  <li className="mr-8 rounded-lg bg-muted p-3 text-muted-foreground">
                    Reading the document…
                  </li>
                )}
                {current.error && (
                  <li className="rounded-lg border border-destructive/30 p-3">
                    <p className="text-sm text-destructive" role="alert">
                      {current.error}
                    </p>
                    {current.retryQuestion && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-2"
                        disabled={busy || !documentReady}
                        onClick={() => void ask(current.retryQuestion!)}
                      >
                        <RotateCcw /> Retry question
                      </Button>
                    )}
                  </li>
                )}
              </ol>
              <SheetFooter className="border-t">
                <form className="grid gap-2" onSubmit={submit}>
                  <Textarea
                    ref={input}
                    value={current.question}
                    onChange={(event) =>
                      setSession({
                        key: targetKey,
                        ...current,
                        question: event.target.value,
                      })}
                    placeholder="Ask about this document"
                    maxLength={4_000}
                    rows={3}
                    disabled={busy || !documentReady}
                    aria-label="Question for Ask OKF"
                  />
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className="min-w-0 truncate text-xs text-muted-foreground"
                      title={`${config.provider} · ${config.model}`}
                    >
                      {config.provider} · {config.model}
                    </span>
                    {busy
                      ? (
                        <Button
                          key="stop"
                          type="button"
                          variant="outline"
                          onClick={(event) => {
                            event.preventDefault();
                            stop();
                          }}
                        >
                          <Square /> Stop
                        </Button>
                      )
                      : (
                        <Button
                          key="ask"
                          type="submit"
                          disabled={!documentReady || !current.question.trim()}
                        >
                          <Send /> Ask
                        </Button>
                      )}
                  </div>
                  {!documentReady && (
                    <p className="text-xs text-muted-foreground" role="status">
                      Save your latest changes before asking.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Answers may contain mistakes. Open the document to verify
                    important details.
                  </p>
                </form>
              </SheetFooter>
            </>
          )}
      </SheetContent>
    </Sheet>
  );
}

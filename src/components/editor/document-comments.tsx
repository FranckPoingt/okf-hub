import { Check, MessageSquare, Quote, RotateCcw, Send } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api, conceptPath } from "../../lib/api.ts";
import type { CommentThread } from "../../lib/models.ts";
import { Avatar, AvatarFallback } from "../ui/avatar.tsx";
import { Button } from "../ui/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet.tsx";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs.tsx";
import { Textarea } from "../ui/textarea.tsx";

export type CommentAnchor = {
  text: string;
  from: number;
  to: number;
} | null;
export type CommentSelection = {
  anchor: NonNullable<CommentAnchor>;
  top: number;
  left: number;
} | null;

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0])
    .join("").toUpperCase() || "?";

export function DocumentComments({
  conceptId,
  revisionNumber,
  open,
  anchor,
  activeThreadId,
  onOpenChange,
  onAnchorChange,
  onCountChange,
}: {
  conceptId: string;
  revisionNumber: number | null;
  open: boolean;
  anchor: CommentAnchor;
  activeThreadId?: string | null;
  onOpenChange: (open: boolean) => void;
  onAnchorChange: (anchor: CommentAnchor) => void;
  onCountChange: (count: number) => void;
}) {
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [body, setBody] = useState("");
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const threadRefs = useRef<Record<string, HTMLElement | null>>({});
  const announceChange = () =>
    globalThis.dispatchEvent(
      new CustomEvent("okf:comments-changed", { detail: { conceptId } }),
    );

  const load = useCallback(async () => {
    const response = await api(
      `${conceptPath(conceptId)}/comments?status=${status}`,
    );
    const result = await response.json() as CommentThread[] & {
      error?: string;
    };
    if (!response.ok) throw new Error(result.error ?? "Comments unavailable");
    setThreads(result);
  }, [conceptId, status]);

  const refreshCount = useCallback(async () => {
    const response = await api(
      `${conceptPath(conceptId)}/comments?status=open`,
    );
    if (response.ok) {
      onCountChange((await response.json() as CommentThread[]).length);
    }
  }, [conceptId, onCountChange]);

  useEffect(() => {
    if (!open) return;
    void load().catch((reason) => setError(reason.message));
  }, [load, open]);

  useEffect(() => {
    if (!open || !activeThreadId) return;
    setStatus("open");
  }, [activeThreadId, open]);

  useEffect(() => {
    if (!open || !activeThreadId) return;
    const frame = requestAnimationFrame(() =>
      threadRefs.current[activeThreadId]?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      })
    );
    return () => cancelAnimationFrame(frame);
  }, [activeThreadId, open, threads]);

  const createThread = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError("");
    const response = await api(`${conceptPath(conceptId)}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body,
        anchorText: anchor?.text,
        anchorStart: anchor?.from,
        anchorEnd: anchor?.to,
        revisionNumber,
      }),
    });
    const result = await response.json() as { error?: string };
    setBusy(false);
    if (!response.ok) return setError(result.error ?? "Comment failed");
    setBody("");
    onAnchorChange(null);
    announceChange();
    if (status === "open") await load();
    else setStatus("open");
    await refreshCount();
  };

  const reply = async (threadId: string) => {
    const message = replies[threadId]?.trim();
    if (!message) return;
    setBusy(true);
    setError("");
    const response = await api(`/api/comment-threads/${threadId}/replies`, {
      method: "POST",
      body: JSON.stringify({ body: message }),
    });
    const result = await response.json() as { error?: string };
    setBusy(false);
    if (!response.ok) return setError(result.error ?? "Reply failed");
    setReplies((current) => ({ ...current, [threadId]: "" }));
    await load();
  };

  const setResolved = async (threadId: string, resolved: boolean) => {
    setBusy(true);
    setError("");
    try {
      const response = await api(`/api/comment-threads/${threadId}`, {
        method: "PATCH",
        body: JSON.stringify({ resolved }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? "Comment update failed");
      }
      announceChange();
      await Promise.all([load(), refreshCount()]);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Comment update failed",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent showOverlay={false} className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="flex items-center gap-2">
            <MessageSquare className="size-4" /> Comments
          </SheetTitle>
          <SheetDescription>
            Discuss the page or reply to a selected passage.
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          <form className="space-y-3 border-b p-4" onSubmit={createThread}>
            {anchor && (
              <blockquote className="flex gap-2 rounded-md border-l-2 border-primary bg-muted/55 p-3 text-xs text-muted-foreground">
                <Quote className="mt-0.5 size-3.5 shrink-0" />
                <span className="line-clamp-3">{anchor.text}</span>
              </blockquote>
            )}
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={4000}
              rows={3}
              placeholder={anchor
                ? "Comment on this selection…"
                : "Start a page discussion…"}
              aria-label={anchor ? "Comment on selection" : "Page comment"}
            />
            <div className="flex items-center justify-between">
              {anchor
                ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onAnchorChange(null)}
                  >
                    Clear selection
                  </Button>
                )
                : (
                  <span className="text-xs text-muted-foreground">
                    Page comment
                  </span>
                )}
              <Button type="submit" size="sm" disabled={busy || !body.trim()}>
                <Send /> Comment
              </Button>
            </div>
          </form>

          <Tabs
            value={status}
            onValueChange={(value) => setStatus(value as "open" | "resolved")}
            className="border-b px-4 py-2"
          >
            <TabsList className="h-8">
              <TabsTrigger value="open">Open</TabsTrigger>
              <TabsTrigger value="resolved">Resolved</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {error && (
              <p className="text-sm text-destructive" role="alert">{error}</p>
            )}
            {!threads.length && !error && (
              <div className="grid min-h-48 place-content-center text-center text-sm text-muted-foreground">
                <MessageSquare className="mx-auto mb-2 size-5" />
                {status === "open"
                  ? "No open comments"
                  : "No resolved comments"}
              </div>
            )}
            {threads.map((thread) => (
              <article
                key={thread.id}
                ref={(element) => {
                  threadRefs.current[thread.id] = element;
                }}
                className={`rounded-lg border bg-card p-3 shadow-xs transition-shadow ${
                  activeThreadId === thread.id ? "ring-2 ring-primary/35" : ""
                }`}
              >
                {thread.anchorText && (
                  <button
                    type="button"
                    className="mb-3 flex w-full gap-2 rounded-md bg-muted/55 p-2 text-left text-xs text-muted-foreground hover:bg-muted"
                    title="Quoted selection"
                  >
                    <Quote className="mt-0.5 size-3 shrink-0" />
                    <span className="line-clamp-2">{thread.anchorText}</span>
                  </button>
                )}
                <div className="space-y-3">
                  {thread.comments.map((comment) => (
                    <div key={comment.id} className="flex gap-2.5">
                      <Avatar size="sm">
                        <AvatarFallback>
                          {initials(
                            comment.authorName ?? comment.authorEmail ??
                              "Unknown",
                          )}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <strong className="truncate text-xs">
                            {comment.authorName ?? comment.authorEmail ??
                              "Unknown"}
                          </strong>
                          <time className="shrink-0 text-[11px] text-muted-foreground">
                            {new Date(comment.createdAt).toLocaleString([], {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </time>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-5">
                          {comment.body}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
                {status === "open" && (
                  <div className="mt-3 flex gap-2 border-t pt-3">
                    <Textarea
                      value={replies[thread.id] ?? ""}
                      onChange={(event) =>
                        setReplies((current) => ({
                          ...current,
                          [thread.id]: event.target.value,
                        }))}
                      rows={1}
                      maxLength={4000}
                      placeholder="Reply…"
                      aria-label="Reply"
                    />
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      disabled={busy || !replies[thread.id]?.trim()}
                      aria-label="Send reply"
                      onClick={() => void reply(thread.id)}
                    >
                      <Send />
                    </Button>
                  </div>
                )}
                <div className="mt-2 flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void setResolved(thread.id, status === "open")}
                  >
                    {status === "open" ? <Check /> : <RotateCcw />}
                    {status === "open" ? "Resolve" : "Reopen"}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

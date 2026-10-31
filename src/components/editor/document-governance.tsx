import {
  CalendarDays,
  CircleCheck,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, conceptPath } from "../../lib/api.ts";
import {
  isReviewDate,
  type KnowledgePerson,
  utcReviewDay,
} from "../../lib/governance.ts";
import type { Concept } from "../../lib/models.ts";
import { formatReviewDate, FreshnessBadge } from "../knowledge-freshness.tsx";
import { Alert, AlertDescription } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { Label } from "../ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select.tsx";

type GovernancePatch = Partial<Pick<Concept, "ownerUserId" | "reviewDueDate">>;
type ReviewRequest = {
  publishedRevision: number;
  reviewDueDate: string | null;
};

export function DocumentGovernance({
  concept,
  canManage,
  view,
  onConceptUpdate,
  onViewPublished,
  onSaveReady,
}: {
  concept: Concept;
  canManage: boolean;
  view: "draft" | "published";
  onConceptUpdate: (updated: Concept) => void;
  onViewPublished: () => void;
  onSaveReady?: (flush: (() => Promise<void>) | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [owners, setOwners] = useState<KnowledgePerson[]>([]);
  const [ownersError, setOwnersError] = useState("");
  const [ownersLoading, setOwnersLoading] = useState(false);
  const [ownersVersion, setOwnersVersion] = useState(0);
  const [ownerValue, setOwnerValue] = useState(concept.ownerUserId ?? "");
  const [dateValue, setDateValue] = useState(concept.reviewDueDate ?? "");
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState<"save" | ReviewRequest | null>(null);
  const latest = useRef(concept);
  const update = useRef(onConceptUpdate);
  update.current = onConceptUpdate;
  const owner = useRef(ownerValue);
  owner.current = ownerValue;
  const date = useRef(dateValue);
  date.current = dateValue;
  const previousFields = useRef({
    owner: concept.ownerUserId ?? "",
    date: concept.reviewDueDate ?? "",
  });
  const requests = useRef(Promise.resolve());
  const desired = useRef<GovernancePatch>({});
  const pending = useRef(0);
  const reviewRunning = useRef(false);
  const reviewRequests = useRef(Promise.resolve());
  const saveError = useRef<Error | null>(null);
  const mounted = useRef(true);
  const dateInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!pending.current && !reviewRunning.current) latest.current = concept;
  }, [concept]);
  useEffect(() => {
    const previous = previousFields.current;
    const next = {
      owner: concept.ownerUserId ?? "",
      date: concept.reviewDueDate ?? "",
    };
    previousFields.current = next;
    if (
      owner.current === previous.owner &&
      !Object.hasOwn(desired.current, "ownerUserId")
    ) {
      owner.current = next.owner;
      setOwnerValue(next.owner);
    }
    if (
      date.current === previous.date &&
      !Object.hasOwn(desired.current, "reviewDueDate")
    ) {
      date.current = next.date;
      setDateValue(next.date);
    }
  }, [concept.ownerUserId, concept.reviewDueDate]);
  useEffect(() => {
    if (!canManage || !open) return;
    const controller = new AbortController();
    setOwnersLoading(true);
    setOwnersError("");
    void api(`${conceptPath(concept.id)}/owners`, { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json() as KnowledgePerson[] & {
          error?: string;
        };
        if (!response.ok) {
          throw new Error(result.error ?? "Workspace editors unavailable");
        }
        if (!controller.signal.aborted) setOwners(result);
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setOwnersError(
            cause instanceof Error
              ? cause.message
              : "Workspace editors unavailable",
          );
        }
      }).finally(() => {
        if (!controller.signal.aborted) setOwnersLoading(false);
      });
    return () => controller.abort();
  }, [canManage, concept.id, open, ownersVersion]);

  const accept = (updated: Concept, saved: GovernancePatch) => {
    const {
      ownerUserId,
      owner: nextOwner,
      reviewDueDate,
      reviewedRevision,
      reviewedAt,
      reviewedBy,
      reviewer,
      freshness,
    } = updated;
    latest.current = {
      ...latest.current,
      ownerUserId,
      owner: nextOwner,
      reviewDueDate,
      reviewedRevision,
      reviewedAt,
      reviewedBy,
      reviewer,
      freshness,
    };
    if (!mounted.current) return;
    if (
      Object.hasOwn(saved, "ownerUserId") &&
      (owner.current || null) === saved.ownerUserId
    ) {
      owner.current = updated.ownerUserId ?? "";
      setOwnerValue(owner.current);
    }
    if (
      Object.hasOwn(saved, "reviewDueDate") &&
      (date.current || null) === saved.reviewDueDate
    ) {
      date.current = updated.reviewDueDate ?? "";
      setDateValue(date.current);
    }
    update.current(updated);
  };
  const save = (patch: GovernancePatch) => {
    if (!canManage || reviewRunning.current) return requests.current;
    desired.current = { ...desired.current, ...patch };
    pending.current++;
    setBusy(true);
    setError("");
    setRetry(null);
    requests.current = requests.current.then(async () => {
      try {
        const currentPatch = { ...desired.current };
        for (
          const key of Object.keys(currentPatch) as Array<keyof GovernancePatch>
        ) {
          if (currentPatch[key] === latest.current[key]) {
            delete currentPatch[key];
            delete desired.current[key];
          }
        }
        if (!Object.keys(currentPatch).length) {
          saveError.current = null;
          return;
        }
        const response = await api(
          `${conceptPath(latest.current.id)}/governance`,
          {
            method: "PUT",
            body: JSON.stringify(currentPatch),
          },
        );
        const result = await response.json() as Concept & { error?: string };
        if (!response.ok) {
          throw new Error(
            result.error ?? "Could not save owner and review date",
          );
        }
        for (
          const key of Object.keys(currentPatch) as Array<keyof GovernancePatch>
        ) {
          if (desired.current[key] === currentPatch[key]) {
            delete desired.current[key];
          }
        }
        saveError.current = null;
        accept(result, currentPatch);
        if (mounted.current) {
          setError("");
          setRetry(null);
        }
      } catch (cause) {
        saveError.current = cause instanceof Error
          ? cause
          : new Error("Could not save owner and review date");
        if (mounted.current) {
          setError(saveError.current.message);
          setRetry("save");
        }
      } finally {
        pending.current--;
        if (mounted.current) setBusy(pending.current > 0);
      }
    });
    return requests.current;
  };
  const readDate = () => {
    const value = date.current;
    if (value && !isReviewDate(value)) {
      throw new Error("Choose a valid next review date, or clear it.");
    }
    return value || null;
  };
  const stageFields = () => {
    const nextDate = readDate();
    const patch: GovernancePatch = {};
    if ((owner.current || null) !== latest.current.ownerUserId) {
      patch.ownerUserId = owner.current || null;
    }
    if (nextDate !== latest.current.reviewDueDate) {
      patch.reviewDueDate = nextDate;
    }
    if (Object.keys(patch).length) save(patch);
  };
  useEffect(() => {
    onSaveReady?.(async () => {
      if (!canManage) return;
      try {
        await reviewRequests.current;
        stageFields();
        await requests.current;
        if (saveError.current) throw saveError.current;
      } catch (cause) {
        if (mounted.current) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not save owner and review date",
          );
        }
        throw cause;
      }
    });
    return () => onSaveReady?.(null);
  }, [canManage, onSaveReady]);
  useEffect(() => {
    if (!canManage) return;
    const protect = (event: BeforeUnloadEvent) => {
      if (
        !pending.current && !reviewRunning.current &&
        !Object.keys(desired.current).length &&
        (owner.current || null) === latest.current.ownerUserId &&
        (date.current || null) === latest.current.reviewDueDate
      ) return;
      event.preventDefault();
      event.returnValue = "";
    };
    globalThis.addEventListener("beforeunload", protect);
    return () => globalThis.removeEventListener("beforeunload", protect);
  }, [canManage]);

  const saveDate = () => {
    if (!canManage || pending.current || reviewRunning.current) return;
    try {
      stageFields();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Choose a valid review date",
      );
      setRetry(null);
    }
  };
  const review = (request?: ReviewRequest) => {
    if (
      !canManage || view !== "published" || !concept.publishedRevision ||
      pending.current || reviewRunning.current ||
      Object.keys(desired.current).length
    ) return reviewRequests.current;
    const task = (async () => {
      let body: ReviewRequest | null = null;
      try {
        const reviewDueDate = request ? request.reviewDueDate : readDate();
        if (reviewDueDate && reviewDueDate < utcReviewDay()) {
          setOpen(true);
          setError(
            "Choose today or a future next review date, or clear the date before marking this revision reviewed.",
          );
          setRetry(null);
          requestAnimationFrame(() => dateInput.current?.focus());
          return;
        }
        body = request ??
          { publishedRevision: concept.publishedRevision!, reviewDueDate };
        reviewRunning.current = true;
        setBusy(true);
        setReviewing(true);
        setError("");
        setRetry(null);
        const response = await api(`${conceptPath(concept.id)}/review`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        const result = await response.json() as Concept & { error?: string };
        if (!response.ok) {
          throw new Error(result.error ?? "Could not record this review");
        }
        saveError.current = null;
        delete desired.current.reviewDueDate;
        accept(result, { reviewDueDate: body.reviewDueDate });
      } catch (cause) {
        const failure = cause instanceof Error
          ? cause
          : new Error("Could not record this review");
        if (mounted.current) {
          setError(failure.message);
          setRetry(body);
        }
      } finally {
        reviewRunning.current = false;
        if (mounted.current) {
          setBusy(pending.current > 0);
          setReviewing(false);
        }
      }
    })();
    reviewRequests.current = task;
    return task;
  };
  const unavailableOwner = ownerValue &&
    !owners.some((person) => person.id === ownerValue);
  const ownerLabel = ownerValue
    ? owners.find((person) => person.id === ownerValue)?.name ??
      (concept.ownerUserId === ownerValue ? concept.owner?.name : undefined) ??
      "Unavailable editor"
    : "Unassigned";
  const reviewerName = concept.reviewer?.name ?? "Former workspace member";
  return (
    <section
      className="document-governance mb-5 grid gap-2 border-b pb-4 text-sm"
      aria-label="Document owner and review"
      aria-busy={busy}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <FreshnessBadge
          freshness={concept.freshness}
          reviewDueDate={concept.reviewDueDate}
        />
        {concept.trust === "stale" && (
          <span className="text-muted-foreground">
            Stale: {concept.trustReason ?? "a dependency changed"}
          </span>
        )}
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <UserRound className="size-3.5" aria-hidden="true" />Owner:{" "}
          {concept.owner?.name ??
            (concept.ownerUserId ? "Unavailable editor" : "Unassigned")}
        </span>
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <CalendarDays className="size-3.5" aria-hidden="true" />
          {concept.reviewDueDate
            ? (
              <>
                Next review{" "}
                <time dateTime={concept.reviewDueDate}>
                  {formatReviewDate(concept.reviewDueDate)}
                </time>
              </>
            )
            : "No review date"}
        </span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          disabled={busy}
        >
          <SlidersHorizontal className="size-3.5" />
          {canManage ? "Owner & review" : "Review details"}
        </Button>
        {busy && (
          <span className="text-xs text-muted-foreground" role="status">
            {reviewing ? "Recording review…" : "Saving owner and review date…"}
          </span>
        )}
      </div>
      {concept.reviewedAt && concept.reviewedRevision
        ? (
          <p className="text-xs text-muted-foreground">
            Published revision {concept.reviewedRevision} reviewed by{" "}
            {reviewerName} on{" "}
            <time
              dateTime={concept.reviewedAt}
              title={new Date(concept.reviewedAt).toLocaleString()}
            >
              {new Date(concept.reviewedAt).toLocaleDateString(undefined, {
                dateStyle: "medium",
              })}
            </time>.{concept.reviewedRevision !== concept.publishedRevision &&
              " The current published revision still needs review."}
          </p>
        )
        : concept.publishedRevision && (
          <p className="text-xs text-muted-foreground">
            Published revision {concept.publishedRevision}{" "}
            has not been reviewed.
          </p>
        )}
      {canManage && concept.publishedRevision && (
        <div className="flex flex-wrap items-center gap-3">
          {view === "published"
            ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-review-published
                disabled={busy || Boolean(Object.keys(desired.current).length)}
                onClick={() => void review()}
              >
                <CircleCheck className="size-3.5" />Mark revision{" "}
                {concept.publishedRevision} reviewed
              </Button>
            )
            : (
              <>
                <span className="text-xs text-muted-foreground">
                  Reviews apply to the published revision.
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={onViewPublished}
                >
                  View published to review
                </Button>
              </>
            )}
        </div>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{error}</span>
            {retry && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy ||
                  (retry !== "save" &&
                    retry.publishedRevision !== concept.publishedRevision)}
                onClick={() =>
                  retry === "save"
                    ? save({ ...desired.current })
                    : void review(retry)}
              >
                {retry === "save" ? "Retry saving" : "Retry review"}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {open && (
        <div className="grid gap-3 pt-2" inert={busy ? true : undefined}>
          {canManage
            ? (
              <>
                <div className="grid gap-1.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-center">
                  <Label htmlFor={`document-owner-${concept.id}`}>Owner</Label>
                  <div className="grid max-w-sm gap-1.5">
                    <Select
                      value={ownerValue || "unassigned"}
                      disabled={busy || ownersLoading || Boolean(ownersError)}
                      onValueChange={(value) => {
                        if (!value) return;
                        const next = value === "unassigned" ? "" : value;
                        owner.current = next;
                        setOwnerValue(next);
                        save({ ownerUserId: next || null });
                      }}
                    >
                      <SelectTrigger
                        id={`document-owner-${concept.id}`}
                        className="w-full"
                      >
                        <SelectValue>{ownerLabel}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unassigned">Unassigned</SelectItem>
                        {unavailableOwner && (
                          <SelectItem value={ownerValue} disabled>
                            {concept.owner?.name ?? "Unavailable editor"}
                          </SelectItem>
                        )}
                        {owners.map((person) => (
                          <SelectItem key={person.id} value={person.id}>
                            {person.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {ownersLoading
                      ? (
                        <p
                          className="text-xs text-muted-foreground"
                          role="status"
                        >
                          Loading workspace editors…
                        </p>
                      )
                      : ownersError
                      ? (
                        <div className="flex items-center gap-2 text-xs text-destructive">
                          <span>{ownersError}</span>
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() =>
                              setOwnersVersion((value) => value + 1)}
                          >
                            Retry
                          </Button>
                        </div>
                      )
                      : (
                        <p className="text-xs text-muted-foreground">
                          Choose a workspace editor responsible for this
                          document.
                        </p>
                      )}
                  </div>
                </div>
                <div className="grid gap-1.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-start">
                  <Label
                    htmlFor={`document-review-date-${concept.id}`}
                    className="pt-1.5"
                  >
                    Next review
                  </Label>
                  <div className="grid max-w-sm gap-1.5">
                    <div className="flex items-center gap-2">
                      <Input
                        ref={dateInput}
                        id={`document-review-date-${concept.id}`}
                        type="date"
                        value={dateValue}
                        disabled={busy}
                        aria-describedby={`document-review-date-hint-${concept.id}`}
                        onChange={(event) => {
                          date.current = event.target.value;
                          setDateValue(event.target.value);
                        }}
                        onBlur={(event) => {
                          if (
                            event.relatedTarget instanceof Element &&
                            event.relatedTarget.closest(
                              "[data-review-published], [data-clear-review-date]",
                            )
                          ) return;
                          saveDate();
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            event.currentTarget.blur();
                          }
                        }}
                      />
                      {dateValue && (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          data-clear-review-date
                          disabled={busy}
                          onClick={() => {
                            date.current = "";
                            setDateValue("");
                            save({ reviewDueDate: null });
                          }}
                        >
                          Clear date
                        </Button>
                      )}
                    </div>
                    <p
                      id={`document-review-date-hint-${concept.id}`}
                      className="text-xs text-muted-foreground"
                    >
                      Optional. Due dates use UTC calendar days. Owner and date
                      changes take effect without publishing.
                    </p>
                  </div>
                </div>
              </>
            )
            : (
              <p className="text-xs text-muted-foreground">
                Review records refer to published content. A new publication
                needs its own review.
              </p>
            )}
        </div>
      )}
    </section>
  );
}

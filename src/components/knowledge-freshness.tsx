import type { Freshness } from "../lib/governance.ts";
import { Badge } from "./ui/badge.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

const reviewDateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** Review deadlines are calendar dates; display their UTC day in every timezone. */
export function formatReviewDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime())
    ? reviewDateFormatter.format(date)
    : value;
}

export function freshnessExplanation(
  freshness: Freshness,
  reviewDueDate?: string | null,
): string {
  const due = reviewDueDate ? formatReviewDate(reviewDueDate) : null;
  switch (freshness.reason) {
    case "not_published":
      return "This document has not been published. Reviews apply to published knowledge.";
    case "never_reviewed":
      return `The published document has not been reviewed yet.${
        due ? ` Review due ${due}.` : ""
      }`;
    case "revision_changed":
      return `The published revision has changed since its last review.${
        due ? ` Review due ${due}.` : ""
      }`;
    case "reviewed":
      return `The current published revision has been reviewed.${
        due ? ` Next review due ${due}.` : ""
      }`;
    case "review_due":
      return `The scheduled review is due today${
        due ? ` (${due})` : ""
      }. Review the published document and mark it reviewed.`;
    case "review_overdue":
      return `The scheduled review is overdue${
        due ? `; it was due ${due}` : ""
      }. Review the published document and mark it reviewed.`;
  }
}

const freshnessLabels: Record<Freshness["status"], string> = {
  unpublished: "Not published",
  unreviewed: "Needs review",
  current: "Reviewed",
  due: "Review due today",
  overdue: "Review overdue",
};

export function FreshnessBadge(
  { freshness, reviewDueDate, className }: {
    freshness: Freshness;
    reviewDueDate?: string | null;
    className?: string;
  },
) {
  const label = freshnessLabels[freshness.status];
  const explanation = freshnessExplanation(freshness, reviewDueDate);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant={freshness.status === "overdue"
              ? "destructive"
              : freshness.status === "unreviewed" || freshness.status === "due"
              ? "secondary"
              : "outline"}
            className={className}
          />
        }
        title={explanation}
        aria-label={`${label}: ${explanation}`}
      >
        {label}
      </TooltipTrigger>
      <TooltipContent>{explanation}</TooltipContent>
    </Tooltip>
  );
}

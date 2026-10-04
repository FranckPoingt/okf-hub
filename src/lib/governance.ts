export type KnowledgePerson = { id: string; name: string };
export type Freshness = {
  status: "unpublished" | "unreviewed" | "current" | "due" | "overdue";
  reason:
    | "not_published"
    | "never_reviewed"
    | "revision_changed"
    | "reviewed"
    | "review_due"
    | "review_overdue";
};
export type GovernanceSummary = {
  ownerUserId: string | null;
  owner: KnowledgePerson | null;
  reviewDueDate: string | null;
  reviewedRevision: number | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewer: KnowledgePerson | null;
  freshness: Freshness;
};

/** Calendar deadlines last through their UTC day, without timezone conversion. */
export function utcReviewDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function isReviewDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

export function deriveFreshness(
  review: {
    publishedRevision: number | null;
    reviewDueDate: string | null;
    reviewedRevision: number | null;
    reviewedAt: string | null;
  },
  today = utcReviewDay(),
): Freshness {
  if (!review.publishedRevision) {
    return { status: "unpublished", reason: "not_published" };
  }
  if (review.reviewDueDate && review.reviewDueDate < today) {
    return { status: "overdue", reason: "review_overdue" };
  }
  if (review.reviewDueDate === today) {
    return { status: "due", reason: "review_due" };
  }
  if (
    review.reviewedRevision === review.publishedRevision && review.reviewedAt
  ) return { status: "current", reason: "reviewed" };
  return {
    status: "unreviewed",
    reason: review.reviewedRevision ? "revision_changed" : "never_reviewed",
  };
}

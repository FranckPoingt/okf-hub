/// <reference lib="deno.ns" />
import assert from "node:assert/strict";
import {
  deriveFreshness,
  isReviewDate,
  utcReviewDay,
} from "../src/lib/governance.ts";

Deno.test("review deadlines accept actual calendar days without coercion", () => {
  for (
    const value of ["2024-02-29", "2026-10-04", "2000-02-29", "2026-12-31"]
  ) {
    assert.equal(isReviewDate(value), true, value);
  }
  for (
    const value of [
      "2023-02-29",
      "1900-02-29",
      "2026-02-30",
      "2026-04-31",
      "2026-00-01",
      "2026-13-01",
      "2026-10-4",
      " 2026-10-04",
      "2026-10-04T00:00:00Z",
      null,
      20261004,
      ["2026-10-04"],
    ]
  ) {
    assert.equal(isReviewDate(value), false, String(value));
  }
});

Deno.test("review freshness belongs to a published revision, independently of draft edits", () => {
  const initial = {
    publishedRevision: null,
    reviewDueDate: "2026-10-03",
    reviewedRevision: null,
    reviewedAt: null,
  };
  assert.deepEqual(deriveFreshness(initial, "2026-10-04"), {
    status: "unpublished",
    reason: "not_published",
  });
  const published = { ...initial, publishedRevision: 1, reviewDueDate: null };
  assert.deepEqual(deriveFreshness(published, "2026-10-04"), {
    status: "unreviewed",
    reason: "never_reviewed",
  });
  const reviewed = {
    ...published,
    reviewedRevision: 1,
    reviewedAt: "2026-10-01T00:00:00Z",
  };
  const drafting = { ...reviewed, draft: "New unpublished changes" };
  assert.deepEqual(deriveFreshness(drafting, "2026-10-04"), {
    status: "current",
    reason: "reviewed",
  });
  assert.deepEqual(
    deriveFreshness({ ...reviewed, publishedRevision: 2 }, "2026-10-04"),
    { status: "unreviewed", reason: "revision_changed" },
  );
  assert.deepEqual(
    deriveFreshness({ ...reviewed, reviewedAt: null }, "2026-10-04"),
    { status: "unreviewed", reason: "revision_changed" },
  );
});

Deno.test("review deadlines become overdue after their UTC day including leap and year boundaries", () => {
  const reviewed = {
    publishedRevision: 3,
    reviewedRevision: 3,
    reviewedAt: "2024-02-01T12:00:00Z",
    reviewDueDate: "2024-02-29",
  };
  assert.deepEqual(deriveFreshness(reviewed, "2024-02-28"), {
    status: "current",
    reason: "reviewed",
  });
  assert.deepEqual(deriveFreshness(reviewed, "2024-02-29"), {
    status: "due",
    reason: "review_due",
  });
  assert.deepEqual(deriveFreshness(reviewed, "2024-03-01"), {
    status: "overdue",
    reason: "review_overdue",
  });
  assert.equal(
    deriveFreshness({ ...reviewed, reviewDueDate: "2025-12-31" }, "2026-01-01")
      .status,
    "overdue",
  );
  assert.equal(
    utcReviewDay(new Date("2026-10-04T00:30:00+13:00")),
    "2026-10-03",
  );
  assert.equal(
    utcReviewDay(new Date("2026-10-04T23:59:59.999Z")),
    "2026-10-04",
  );
  assert.equal(
    deriveFreshness(
      { ...reviewed, reviewDueDate: "2026-10-04" },
      utcReviewDay(new Date("2026-10-05T00:00:00.000Z")),
    ).status,
    "overdue",
  );
});

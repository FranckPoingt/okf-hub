/// <reference lib="deno.ns" />
import assert from "node:assert/strict";
import { statusBadge } from "../src/lib/status.ts";

Deno.test("status badges share one label and tone per machine state", () => {
  assert.deepEqual(statusBadge("sync_failed"), {
    label: "Sync failed",
    variant: "destructive",
  });
  assert.deepEqual(statusBadge("live"), { label: "Live", variant: "success" });
  assert.deepEqual(statusBadge("needs_attention"), {
    label: "Needs attention",
    variant: "warning",
  });
  assert.deepEqual(statusBadge("queued_retry"), {
    label: "Queued retry",
    variant: "secondary",
  });
});

Deno.test("review attention reasons cover due, overdue and unreviewed only", async () => {
  const { reviewAttention } = await import(
    "../src/lib/governance.ts"
  );
  const at = (status: string, reason: string, due?: string) =>
    reviewAttention({ status, reason } as never, due);
  assert.equal(at("due", "review_due", "2026-03-01"), "Review due Mar 1, 2026");
  assert.equal(at("due", "review_due"), "Review due today");
  assert.equal(
    at("overdue", "review_overdue", "2026-03-01"),
    "Review overdue since Mar 1, 2026",
  );
  assert.equal(
    at("unreviewed", "never_reviewed"),
    "Published document not reviewed yet",
  );
  assert.equal(at("current", "reviewed"), null);
  assert.equal(at("unpublished", "not_published"), null);
});

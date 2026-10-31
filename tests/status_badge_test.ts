/// <reference lib="deno.ns" />
import assert from "node:assert/strict";
import { statusBadge } from "../src/lib/status.ts";

Deno.test("status badges share one label and tone per machine state", () => {
  assert.deepEqual(statusBadge("sync_failed"), {
    label: "Sync failed",
    variant: "destructive",
  });
  assert.deepEqual(statusBadge("live"), { label: "Live", variant: "success" });
  assert.deepEqual(statusBadge("stale"), {
    label: "Stale",
    variant: "warning",
  });
  assert.deepEqual(statusBadge("queued_retry"), {
    label: "Queued retry",
    variant: "secondary",
  });
});

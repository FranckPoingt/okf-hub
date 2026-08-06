/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { parseAppRoute, routePath } from "../src/routes.ts";

Deno.test("round-trips stable app routes and rejects malformed paths", () => {
  const routes = [
    { kind: "home" as const },
    { kind: "search" as const },
    { kind: "sources" as const },
    { kind: "manage" as const },
    { kind: "concept" as const, id: "incident-communication" },
    {
      kind: "imported" as const,
      sourceId: "repository-platform",
      path: "guides/on call.md",
    },
  ];
  for (const route of routes) {
    assert.deepEqual(parseAppRoute(routePath(route)), route);
  }
  assert.deepEqual(parseAppRoute("/knowledge/%zz"), { kind: "not_found" });
  assert.deepEqual(parseAppRoute("/private"), { kind: "not_found" });
});

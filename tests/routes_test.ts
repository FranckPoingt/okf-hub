/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import {
  type AppRoute,
  parseAppRoute,
  resolveImportedLink,
  routePath,
  SETTINGS_SECTIONS,
} from "../src/routes.ts";

Deno.test("round-trips stable app routes and rejects malformed paths", () => {
  const routes: Exclude<AppRoute, { kind: "not_found" }>[] = [
    { kind: "home" as const },
    { kind: "search" as const },
    { kind: "sources" as const },
    { kind: "developer" as const },
    { kind: "space" as const, id: "people-operations" },
    ...SETTINGS_SECTIONS.map((section) => ({
      kind: "manage" as const,
      section,
    })),
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
  assert.deepEqual(parseAppRoute("/settings"), {
    kind: "manage",
    section: "general",
  });
  assert.deepEqual(parseAppRoute("/manage"), {
    kind: "manage",
    section: "general",
  });
  assert.deepEqual(parseAppRoute("/settings/unknown"), { kind: "not_found" });
  assert.deepEqual(parseAppRoute("/spaces/People"), { kind: "not_found" });
  assert.deepEqual(parseAppRoute("/knowledge/%zz"), { kind: "not_found" });
  assert.deepEqual(parseAppRoute("/private"), { kind: "not_found" });
});

Deno.test("resolves OKF links inside their imported source", () => {
  assert.equal(
    resolveImportedLink(
      "policies/revenue-recognition.md",
      "/tables/orders.md",
    ),
    "tables/orders.md",
  );
  assert.equal(
    resolveImportedLink("policies/margin-standard.md", "../metrics/revenue.md"),
    "metrics/revenue.md",
  );
  assert.equal(
    resolveImportedLink("policies/margin-standard.md", "#formula"),
    null,
  );
  assert.equal(
    resolveImportedLink("policies/margin-standard.md", "https://example.com"),
    null,
  );
});

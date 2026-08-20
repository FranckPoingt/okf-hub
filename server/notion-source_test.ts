import assert from "node:assert/strict";
import { syncNotionSource } from "./notion-source.ts";

Deno.test("imports paginated Notion pages as stable read-only Markdown", async () => {
  const calls: string[] = [];
  const request = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    assert.equal(
      new Headers(init?.headers).get("notion-version"),
      "2025-09-03",
    );
    if (url.pathname === "/v1/search") {
      const body = JSON.parse(String(init?.body));
      return Promise.resolve(
        Response.json(
          body.start_cursor
            ? {
              results: [{
                id: "page-2",
                last_edited_time: "2026-08-12",
                properties: {
                  Name: { type: "title", title: [{ plain_text: "Second" }] },
                },
              }],
              has_more: false,
            }
            : {
              results: [{
                id: "page-1",
                last_edited_time: "2026-08-11",
                properties: {
                  Name: { type: "title", title: [{ plain_text: "Runbook" }] },
                },
              }],
              has_more: true,
              next_cursor: "next",
            },
        ),
      );
    }
    if (url.pathname.endsWith("page-1/children")) {
      return Promise.resolve(Response.json({
        results: [
          {
            id: "heading",
            type: "heading_1",
            heading_1: { rich_text: [{ plain_text: "Response" }] },
          },
          {
            id: "todo",
            type: "to_do",
            to_do: { rich_text: [{ plain_text: "Notify" }], checked: true },
            has_children: true,
          },
          { id: "unsupported", type: "synced_block", synced_block: {} },
        ],
        has_more: false,
      }));
    }
    if (url.pathname.endsWith("todo/children")) {
      return Promise.resolve(Response.json({
        results: [{
          id: "nested",
          type: "paragraph",
          paragraph: { rich_text: [{ plain_text: "Nested detail" }] },
        }],
        has_more: false,
      }));
    }
    return Promise.resolve(Response.json({ results: [], has_more: false }));
  };
  const snapshot = await syncNotionSource(
    { token: "secret" },
    request as typeof fetch,
  );
  assert.equal(snapshot.files.length, 2);
  assert.equal(snapshot.files[0].path, "page-1.md");
  assert.match(snapshot.files[0].markdown, /title: "Runbook"/);
  assert.match(
    snapshot.files[0].markdown,
    /# Response\n\n- \[x\] Notify\n\nNested detail/,
  );
  assert.deepEqual(snapshot.issues, [{
    path: "page-1.md#unsupported",
    error: "Unsupported Notion block: synced_block",
  }]);
  assert.ok(calls.includes("POST /v1/search"));
  assert.ok(calls.includes("GET /v1/blocks/page-1/children?page_size=100"));
});

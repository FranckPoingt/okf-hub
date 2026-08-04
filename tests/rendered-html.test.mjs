import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("renders the KH-01 workflow narrative", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>OKF Hub — Design partner workflow<\/title>/i);
  assert.match(html, /Connect your company knowledge/);
  assert.match(html, /acme\/api/);
  assert.match(html, /Write a policy/);
  assert.match(html, /Find the answer/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/);
});

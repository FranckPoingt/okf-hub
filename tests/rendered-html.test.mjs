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

test("renders the KH-02 collaborative editor shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>OKF Hub — Collaborative editor proof<\/title>/i);
  assert.match(html, /Incident communication/);
  assert.match(html, /Open collaborator/);
  assert.match(html, /Import \.md/);
  assert.match(html, /Export \.md/);
  assert.doesNotMatch(html, /Design partner|codex-preview/);
});

/// <reference lib="deno.ns" />

import assert from "node:assert/strict";

Deno.test("builds the lifecycle and connected-source shell", async () => {
  const html = await Deno.readTextFile("dist/index.html");
  assert.match(html, /<title>OKF Hub — Portable company knowledge<\/title>/);

  const scripts: string[] = [];
  for await (const entry of Deno.readDir("dist/assets")) {
    if (entry.isFile && entry.name.endsWith(".js")) {
      scripts.push(await Deno.readTextFile(`dist/assets/${entry.name}`));
    }
  }
  const bundle = scripts.join("\n");
  assert.match(bundle, /Create your account/);
  assert.match(bundle, /Invite through a group/);
  assert.match(bundle, /View only/);
  assert.match(bundle, /Published revisions/);
  assert.match(bundle, /Restore as draft/);
  assert.match(bundle, /Restore concept/);
  assert.match(bundle, /Repository-owned OKF/);
  assert.match(bundle, /Refresh repository/);
  assert.match(bundle, /Shared controlled OKF/);
  assert.match(bundle, /Refresh shared store/);
  assert.match(bundle, /Search company knowledge/);
  assert.match(bundle, /Include archived/);
  assert.match(bundle, /Linked from/);
  assert.match(bundle, /Source issues/);
  assert.match(bundle, /connected source is authoritative/);
  assert.match(bundle, /SHARED STORE/);
  assert.doesNotMatch(bundle, /Import \.md/);
});

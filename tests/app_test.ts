/// <reference lib="deno.ns" />

import assert from "node:assert/strict";

Deno.test("builds the collaborative editor shell", async () => {
  const html = await Deno.readTextFile("dist/index.html");
  assert.match(html, /<title>OKF Hub — Collaborative editor proof<\/title>/);

  const scripts: string[] = [];
  for await (const entry of Deno.readDir("dist/assets")) {
    if (entry.isFile && entry.name.endsWith(".js")) scripts.push(await Deno.readTextFile(`dist/assets/${entry.name}`));
  }
  const bundle = scripts.join("\n");
  assert.match(bundle, /Create your account/);
  assert.match(bundle, /Invite through a group/);
  assert.match(bundle, /View only/);
  assert.match(bundle, /Import \.md/);
  assert.match(bundle, /Export \.md/);
});

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
  assert.match(bundle, /Private credentials stored/);
  assert.match(bundle, /Access token/);
  assert.match(bundle, /Disconnect repository/);
  assert.match(bundle, /Shared controlled OKF/);
  assert.match(bundle, /Refresh shared store/);
  assert.match(bundle, /Search company knowledge/);
  assert.match(bundle, /Include archived/);
  assert.match(bundle, /Linked from/);
  assert.match(bundle, /Run checks now/);
  assert.match(bundle, /Fix broken link/);
  assert.match(bundle, /Source issues/);
  assert.match(bundle, /connected source is authoritative/);
  assert.match(bundle, /SHARED STORE/);
  assert.match(bundle, /Reviewed tools and dashboards/);
  assert.match(bundle, /Create draft artifact/);
  assert.match(bundle, /Make version/);
  assert.match(bundle, /allow-scripts/);
  assert.match(bundle, /Create and manage knowledge/);
  assert.match(bundle, /New document/);
  assert.match(bundle, /Documents inherit access from their space/);
  assert.match(bundle, /Create space/);
  assert.match(bundle, /Document settings/);
  assert.match(bundle, /Download OKF/);
  assert.match(bundle, /Delete empty space/);
  assert.match(bundle, /Moving a document keeps every draft/);
  assert.match(bundle, /Your knowledge hub/);
  assert.match(
    bundle,
    /Everything here already follows your access permissions/,
  );
  assert.match(bundle, /Recently updated/);
  assert.match(bundle, /Unpublished drafts/);
  assert.match(bundle, /Search knowledge/);
  assert.match(bundle, /Knowledge page not found/);
  assert.match(bundle, /This knowledge page is unavailable/);
  assert.match(bundle, /popstate/);
  assert.doesNotMatch(
    await Deno.readTextFile("src/App.tsx"),
    /dangerouslySetInnerHTML/,
  );
  assert.doesNotMatch(bundle, /Import \.md/);
});

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  bundleContent,
  decodeFile,
  dependencies,
  encodeFile,
  fileText,
  MAX_BYTES,
  sha256,
  validateDependencies,
} from "./artifact-bundle.ts";
import { createArtifactStore } from "./artifact-store.ts";
import { prepareArtifactUpload } from "./artifact-upload.ts";
import { createZip } from "./export-archive.ts";
import { vendorDependencies } from "../scripts/vendor-artifact.ts";
const text = (path: string, type: string, body: string) =>
  encodeFile(path, type, new TextEncoder().encode(body));

Deno.test("vendors CDN scripts, compact ESM imports, CSS and fonts with stored byte hashes", async () => {
  const files = [
    text(
      "index.html",
      "text/html",
      `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Test"><script src="https://unpkg.com/react/umd.js"></script><script type="module">import{chart}from"https://esm.sh/chart?bundle"; chart();</script>`,
    ),
  ];
  const calls: string[] = [];
  const request: typeof fetch = (input, init) => {
    calls.push(String(input));
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.headers, undefined);
    const url = String(input);
    return Promise.resolve(
      new Response(
        url.includes("googleapis")
          ? `@font-face{src:url(https://fonts.gstatic.com/test.woff2)}`
          : url.includes("gstatic")
          ? "font-bytes"
          : url.includes("esm.sh")
          ? "export const chart=()=>1;"
          : "window.React={};",
        {
          headers: {
            "content-type": url.includes("googleapis")
              ? "text/css"
              : url.includes("gstatic")
              ? "font/woff2"
              : "text/javascript",
          },
        },
      ),
    );
  };
  const manifest = await vendorDependencies(files, request);
  assert.equal(manifest.length, 4);
  assert.equal(calls.length, 4);
  assert.match(fileText(files[0]), /from"\.\/vendor\//);
  assert.doesNotMatch(fileText(files[0]), /https:/);
  // Vendoring rewrites ESM, but the sandbox can't load modules yet.
  assert.throws(() => validateDependencies(files), /Module scripts/);
  for (const record of manifest) {
    assert.equal(
      record.sha256,
      await sha256(decodeFile(files.find((f) => f.path === record.path)!)),
    );
  }
  assert.deepEqual(
    JSON.parse(fileText(files.find((f) => f.path === "vendor.json")!)),
    manifest,
  );
  assert.equal(
    dependencies('export{a}from"https://esm.sh/a";', "text/javascript")[0]
      .target,
    "https://esm.sh/a",
  );
});

Deno.test("vendoring rejects nested imports, off-allowlist redirects and resource excess", async () => {
  const files = () => [
    text(
      "index.html",
      "text/html",
      '<script src="https://esm.sh/chart?bundle"></script>',
    ),
  ];
  await assert.rejects(
    () =>
      vendorDependencies(files(), () =>
        Promise.resolve(
          new Response('export{a}from"/nested.js";', {
            headers: { "content-type": "text/javascript" },
          }),
        )),
    /Nested import.*https:\/\/esm.sh\/nested.js/,
  );
  await assert.rejects(
    () =>
      vendorDependencies(files(), () =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/file.js" },
          }),
        )),
    /not allowed.*evil/,
  );
  const many = [
    ...files(),
    ...Array.from(
      { length: 198 },
      (_, i) => text(`${i}.txt`, "text/plain", "x"),
    ),
  ];
  await assert.rejects(() => vendorDependencies(many, fetch), /200 files/);
  await assert.rejects(
    () =>
      vendorDependencies(
        files(),
        () => Promise.resolve(new Response(new Uint8Array(MAX_BYTES + 1))),
      ),
    /8 MiB/,
  );
});

Deno.test("App store rejects CDN dependencies on create and revise, including inline HTML", () => {
  const db = new DatabaseSync(":memory:");
  const store = createArtifactStore(db);
  const base = {
    conceptId: "test",
    title: "Test",
    actorUserId: "user",
    type: "inline_html" as const,
  };
  try {
    const remote = '<script src="https://cdn.jsdelivr.net/npm/react"></script>';
    assert.throws(() => store.create({ ...base, content: remote }), /--vendor/);
    assert.throws(
      () =>
        store.create({
          ...base,
          content: bundleContent([text("index.html", "text/html", remote)]),
        }),
      /--vendor/,
    );
    const app = store.create({ ...base, content: "<p>Hello</p>" })!;
    assert.throws(() => store.revise(app.id, remote, "user"), /--vendor/);
    assert.equal(store.list("test", true)[0]!.version, 1);
    assert.throws(
      () =>
        store.create({
          ...base,
          content: bundleContent([
            text(
              "index.html",
              "text/html",
              '<script type="module">import{chart}from"./vendor/chart.js";</script>',
            ),
            text("vendor/chart.js", "text/javascript", "export const chart=1;"),
          ]),
        }),
      /Module scripts/,
    );
    const bundled = store.create({
      ...base,
      content: bundleContent([text("index.html", "text/html", "<p>Hi</p>")]),
    })!;
    const served = new TextDecoder().decode(
      store.file(bundled.id, "", true)!.body,
    );
    assert.match(served, /connect-src 'none'/);
  } finally {
    db.close();
  }
});

Deno.test("uploads accept HTML and deflated ZIP, request context, and reject missing files and limits", async () => {
  const html = new TextEncoder().encode("<h1>Hello</h1>");
  assert.deepEqual(prepareArtifactUpload("test.html", html), {
    needsContext: true,
  });
  const prepared = prepareArtifactUpload(
    "test.html",
    html,
    "Hello",
    "A useful chart",
  );
  assert.equal(prepared.needsContext, false);
  if (!prepared.needsContext) {
    assert.match(prepared.markdown, /type: Artifact/);
    assert.match(prepared.content, /context.md/);
  }
  const zip = await createZip([{ path: "index.html", body: html }, {
    path: "context.md",
    body: "# Uploaded chart\n\nContext",
  }]);
  const imported = prepareArtifactUpload("test.zip", zip);
  assert.equal(imported.needsContext, false);
  if (!imported.needsContext) assert.equal(imported.title, "Uploaded chart");
  const badZip = await createZip([{
    path: "index.html",
    body: '<script src="https://unpkg.com/react"></script>',
  }, { path: "context.md", body: "# Context" }]);
  assert.throws(() => prepareArtifactUpload("test.zip", badZip), /--vendor/);
  assert.throws(
    () => prepareArtifactUpload("test.html", new Uint8Array(MAX_BYTES + 1)),
    /8 MiB/,
  );
  const missingZip = await createZip([{ path: "other.txt", body: "x" }]);
  assert.throws(
    () => prepareArtifactUpload("test.zip", missingZip),
    /index.html/,
  );
  assert.throws(
    () =>
      bundleContent(
        Array.from(
          { length: 201 },
          (_, i) => text(`${i}.txt`, "text/plain", ""),
        ),
      ),
    /200 files/,
  );
  assert.throws(
    () =>
      bundleContent([text("index.html", "text/html", "x".repeat(MAX_BYTES))]),
    /8 MiB/,
  );
  const bomb = await createZip([{
    path: "index.html",
    body: "x".repeat(MAX_BYTES),
  }]);
  const view = new DataView(bomb.buffer);
  for (let i = 0; i < bomb.length - 46; i++) {
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint32(i + 24, 1, true);
      break;
    }
  }
  assert.throws(
    () => prepareArtifactUpload("test.zip", bomb),
    /larger|length|size|buffer/i,
  );
});

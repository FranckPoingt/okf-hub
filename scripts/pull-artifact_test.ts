import assert from "node:assert/strict";
import { pullArtifact } from "./pull-artifact.ts";
import { packArtifactFiles } from "../server/artifact-save.ts";
import { PREFIX } from "../server/artifact-bundle.ts";

Deno.test("artifact pull validates paths and refuses existing destinations before writing", async () => {
  const previous = Deno.env.get("OKF_HUB_TOKEN");
  Deno.env.set("OKF_HUB_TOKEN", "okf_test");
  const root = await Deno.makeTempDir();
  try {
    const packed = await packArtifactFiles([
      { path: "context.md", bytes: new TextEncoder().encode("# Example") },
      { path: "index.html", bytes: new TextEncoder().encode("<p>Example</p>") },
    ]);
    const files = JSON.parse(packed.content.slice(PREFIX.length)).files;
    const result = {
      context: { spaceId: "policies" },
      appId: "app",
      digest: packed.digest,
      files: Object.fromEntries(
        files.map((file: { path: string }) => [file.path, file]),
      ),
    };
    const request = (() =>
      Promise.resolve(Response.json({ result }))) as typeof fetch;
    await Deno.mkdir(`${root}/existing`);
    await Deno.writeTextFile(`${root}/existing/keep.txt`, "Keep");
    await assert.rejects(
      () =>
        pullArtifact(
          "https://hub.example/knowledge/doc",
          `${root}/existing`,
          request,
        ),
      Deno.errors.AlreadyExists,
    );
    assert.equal(await Deno.readTextFile(`${root}/existing/keep.txt`), "Keep");
    result.files["../escape.md"] = result.files["context.md"];
    await assert.rejects(
      () =>
        pullArtifact(
          "https://hub.example/knowledge/doc",
          `${root}/new`,
          request,
        ),
      /Excluded artifact file|unsafe filename/,
    );
    await assert.rejects(() => Deno.stat(`${root}/new`), Deno.errors.NotFound);
    await assert.rejects(
      () => Deno.stat(`${root}/escape.md`),
      Deno.errors.NotFound,
    );
  } finally {
    if (previous === undefined) Deno.env.delete("OKF_HUB_TOKEN");
    else Deno.env.set("OKF_HUB_TOKEN", previous);
    await Deno.remove(root, { recursive: true });
  }
});

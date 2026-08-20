/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { createZip } from "./export-archive.ts";

Deno.test("creates a portable ZIP with nested files", async () => {
  const archive = await createZip([
    { path: "Policies/Parent/_index.md", body: "# Parent\n" },
    { path: "Policies/Parent/apps/Checklist/index.html", body: "<p>Hi</p>" },
  ]);
  const view = new DataView(archive.buffer);
  const decoder = new TextDecoder();
  const entries: Record<string, string> = {};
  for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(
      archive.subarray(offset + 30, offset + 30 + nameLength),
    );
    const bodyOffset = offset + 30 + nameLength + extraLength;
    const body = archive.slice(bodyOffset, bodyOffset + compressedSize);
    entries[name] = decoder.decode(
      new Uint8Array(
        await new Response(
          new Blob([body]).stream().pipeThrough(
            new DecompressionStream("deflate-raw"),
          ),
        ).arrayBuffer(),
      ),
    );
    offset = bodyOffset + compressedSize;
  }
  assert.deepEqual(entries, {
    "Policies/Parent/_index.md": "# Parent\n",
    "Policies/Parent/apps/Checklist/index.html": "<p>Hi</p>",
  });
});

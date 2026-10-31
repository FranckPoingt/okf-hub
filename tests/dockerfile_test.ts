/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { dirname, join, normalize } from "node:path";

// The runtime image copies only `server/` plus a few `src/` paths; every
// `src/` file the server graph imports must be copied or the build fails.
Deno.test("Dockerfile copies every src file the server imports", async () => {
  const copied = [
    ...(await Deno.readTextFile("Dockerfile")).matchAll(
      /^COPY (src\/\S+) \.\/src\/\S+$/gm,
    ),
  ].map((match) => match[1].replace(/\/$/, ""));
  const seen = new Set<string>();
  const queue = ["server/main.ts", "server/admin.ts"];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await Deno.readTextFile(file);
    for (const [, specifier] of source.matchAll(/from "(\.[^"]+\.ts)"/g)) {
      queue.push(normalize(join(dirname(file), specifier)));
    }
  }
  const missing = [...seen].filter((file) =>
    file.startsWith("src/") &&
    !copied.some((path) => file === path || file.startsWith(`${path}/`))
  );
  assert.deepEqual(missing, []);
});

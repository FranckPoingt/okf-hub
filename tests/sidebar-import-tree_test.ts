import assert from "node:assert/strict";
import { importTree } from "../src/lib/import-tree.ts";

const item = (path: string) => ({
  id: path,
  sourceId: "repo",
  path,
  title: path.split("/").at(-1)!,
});

Deno.test("importTree nests folders, sorts them first and merges single-folder chains", () => {
  const root = importTree([
    item("z-root.md"),
    item("docs/guides/setup.md"),
    item("docs/guides/api/auth.md"),
    item("adr/0001.md"),
    item("a-root.md"),
  ]);
  assert.deepEqual(root.folders.map((folder) => folder.name), [
    "adr",
    "docs/guides",
  ]);
  assert.deepEqual(root.items.map((file) => file.title), [
    "a-root.md",
    "z-root.md",
  ]);
  const guides = root.folders[1];
  assert.equal(guides.path, "docs/guides");
  assert.deepEqual(guides.items.map((file) => file.title), ["setup.md"]);
  assert.equal(guides.folders[0].name, "api");
  assert.equal(guides.folders[0].path, "docs/guides/api");
});

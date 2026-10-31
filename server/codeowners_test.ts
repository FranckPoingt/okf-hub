/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import {
  globPattern,
  ownersFor,
  parseCodeowners,
  readCodeowners,
} from "./codeowners.ts";

Deno.test("matches gitignore-style globs", () => {
  const cases: [string, string, boolean][] = [
    ["src/billing/**", "src/billing/invoice/tax.ts", true],
    ["src/billing/**", "src/billingx/tax.ts", false],
    ["src/billing", "src/billing/tax.ts", true],
    ["/src/*.ts", "src/main.ts", true],
    ["/src/*.ts", "src/lib/main.ts", false],
    ["*.sql", "db/migrations/1.sql", true],
    ["docs/*", "docs/guide.md", true],
    ["docs/*", "docs/build/guide.md", false],
    ["apps/", "packages/apps/web.ts", true],
    ["apps/", "apps", false],
    ["**/logs", "deep/a/logs/today.txt", true],
    ["a?c.md", "abc.md", true],
    ["a.c", "abc", false],
  ];
  for (const [glob, path, expected] of cases) {
    assert.equal(globPattern(glob).test(path), expected, `${glob} ~ ${path}`);
  }
});

Deno.test("CODEOWNERS uses the last matching rule", () => {
  const rules = parseCodeowners(`
# Default owners
*       @org/everyone
/okf/   @org/docs   # inline comment
*.ts    @org/ts
/okf/billing.md @alice @bob
/okf/unowned.md
`);
  assert.deepEqual(ownersFor(rules, "okf/billing.md"), ["@alice", "@bob"]);
  assert.deepEqual(ownersFor(rules, "okf/other.md"), ["@org/docs"]);
  assert.deepEqual(ownersFor(rules, "okf/tool.ts"), ["@org/ts"]);
  assert.deepEqual(ownersFor(rules, "README.md"), ["@org/everyone"]);
  assert.deepEqual(ownersFor(rules, "okf/unowned.md"), []);
});

Deno.test("reads the first CODEOWNERS location GitHub would use", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/.github`);
    await Deno.mkdir(`${root}/docs`);
    await Deno.writeTextFile(`${root}/CODEOWNERS`, "* @root");
    await Deno.writeTextFile(`${root}/docs/CODEOWNERS`, "* @docs");
    assert.deepEqual(ownersFor(await readCodeowners(root), "a"), ["@root"]);
    await Deno.writeTextFile(`${root}/.github/CODEOWNERS`, "* @github");
    assert.deepEqual(ownersFor(await readCodeowners(root), "a"), ["@github"]);
    assert.deepEqual(await readCodeowners(`${root}/missing`), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

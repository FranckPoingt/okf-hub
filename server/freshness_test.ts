/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createFreshnessStore,
  documentSources,
  inspectRepositoryFreshness,
  type StaleReason,
} from "./freshness.ts";
import { syncRepository } from "./repository-source.ts";

async function git(cwd: string, ...args: string[]) {
  const result = await new Deno.Command("git", {
    cwd,
    args,
    stderr: "piped",
  }).output();
  assert.equal(result.success, true, new TextDecoder().decode(result.stderr));
}

const billing = (note = "") =>
  `---\ntype: Guide\ntitle: Billing\ndescribes: [src/billing/**]\n---\n\n# Billing${note}\n`;

Deno.test("marks described code changes stale and clears them on concept updates", async () => {
  const root = await Deno.makeTempDir();
  const origin = `${root}/origin`;
  const checkout = `${root}/checkout`;
  const previous = new Map<
    string,
    { contentHash: string; stale: StaleReason | null }
  >();
  const write = async (path: string, text: string) => {
    await Deno.mkdir(`${origin}/${path.split("/").slice(0, -1).join("/")}`, {
      recursive: true,
    });
    await Deno.writeTextFile(`${origin}/${path}`, text);
  };
  const commit = async () => {
    await git(origin, "add", ".");
    await git(origin, "commit", "-m", "change");
  };
  let revision: string | null = null;
  // Mirrors the Hub: state only advances when the whole sync succeeds.
  const sync = async () => {
    const snapshot = await syncRepository(checkout, origin, "okf");
    const result = await inspectRepositoryFreshness({
      checkout,
      folder: "okf",
      from: revision,
      to: snapshot.revision,
      files: snapshot.files,
      previous,
    });
    revision = snapshot.revision;
    for (const file of snapshot.files) {
      previous.set(file.path, {
        contentHash: file.hash,
        stale: result.get(file.path)!.stale,
      });
    }
    return { snapshot, result };
  };
  try {
    await Deno.mkdir(origin);
    await git(origin, "init", "--initial-branch=main");
    await git(origin, "config", "user.email", "test@example.com");
    await git(origin, "config", "user.name", "Test");
    await write("okf/billing.md", billing());
    await write("okf/other.md", "---\ntype: Guide\nowner: Explicit\n---\n");
    await write("src/billing/tax.ts", "export const rate = 1;\n");
    await write("src/billing/legacy/old.ts", "export {};\n");
    await write("src/auth.ts", "export {};\n");
    await write(
      ".github/CODEOWNERS",
      "* @org/all\n/okf/ @org/docs\n/src/billing/ @org/billing\n/src/billing/legacy/ @org/legacy\n",
    );
    await commit();

    const first = await sync();
    assert.equal(first.result.get("billing.md")!.stale, null);
    const files = new Map(
      first.snapshot.files.map((file) => [file.path, file]),
    );
    assert.equal(files.get("billing.md")!.owner, "@org/docs");
    assert.match(files.get("billing.md")!.searchText, /@org\/docs/);
    assert.equal(files.get("other.md")!.owner, "Explicit");
    assert.deepEqual(first.result.get("billing.md")!.describes, [
      "src/billing/**",
    ]);
    assert.deepEqual(
      first.result.get("billing.md")!.describedOwners.sort(),
      ["@org/billing", "@org/legacy"],
    );

    await write("src/auth.ts", "export const changed = true;\n");
    await commit();
    assert.equal((await sync()).result.get("billing.md")!.stale, null);

    // Retrying the same revision is idempotent.
    assert.equal((await sync()).result.get("billing.md")!.stale, null);

    await write("src/billing/tax.ts", "export const rate = 2;\n");
    await commit();
    const staleSync = await sync();
    const stale = staleSync.result.get("billing.md")!.stale!;
    assert.deepEqual(stale.paths, ["src/billing/tax.ts"]);
    assert.notEqual(stale.from, stale.to);
    assert.equal(staleSync.result.get("other.md")!.stale, null);
    assert.deepEqual((await sync()).result.get("billing.md")!.stale, stale);

    await write("okf/billing.md", billing(" updated"));
    await commit();
    assert.equal((await sync()).result.get("billing.md")!.stale, null);

    await write("src/billing/tax.ts", "export const rate = 3;\n");
    await write("okf/billing.md", billing(" same push"));
    await commit();
    assert.equal((await sync()).result.get("billing.md")!.stale, null);

    // An unknown previous revision never marks anything stale.
    await write("src/billing/tax.ts", "export const rate = 4;\n");
    await commit();
    revision = "0".repeat(40);
    assert.equal((await sync()).result.get("billing.md")!.stale, null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cascades stale and missing sources to dependent documents", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE okf_concept (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE okf_imported_concept (
      id TEXT PRIMARY KEY, path TEXT NOT NULL, status TEXT NOT NULL
    );
    INSERT INTO okf_concept VALUES ('artifact', 'active'), ('summary', 'active'), ('old', 'archived');
    INSERT INTO okf_imported_concept VALUES
      ('repo/billing', 'billing.md', 'current'),
      ('repo/gone', 'gone.md', 'deleted');
  `);
  const store = createFreshnessStore(db);
  const sources = (markdown: string) =>
    store.setSources("artifact", documentSources(markdown)!);

  sources(
    "---\ntype: Artifact\nsources:\n  - id: spec\n    resource: https://example.com\n  - billing\n---\n",
  );
  assert.equal(store.dependency("artifact"), null);

  store.save("repo/billing", {
    describes: ["src/billing/**"],
    describedOwners: [],
    stale: { from: "a".repeat(40), to: "b".repeat(40), paths: ["src/x.ts"] },
  });
  assert.equal(
    store.dependency("artifact"),
    "Depends on billing: Described code changed in aaaaaaa..bbbbbbb: src/x.ts",
  );

  sources("---\ntype: Artifact\nsources: [gone.md]\n---\n");
  assert.match(store.dependency("artifact")!, /gone\.md: source missing/);

  sources("---\ntype: Artifact\nsources: [/knowledge/old]\n---\n");
  assert.match(store.dependency("artifact")!, /source archived/);

  // Hub documents cascade through each other, without looping.
  store.setSources("summary", ["repo/billing", "artifact"]);
  sources("---\ntype: Artifact\nsources: [summary]\n---\n");
  assert.match(store.dependency("artifact")!, /^Depends on summary: Depends/);

  assert.equal(documentSources("# Body only\n"), null);
  assert.deepEqual(documentSources("---\ntype: Guide\n---\n"), []);
});

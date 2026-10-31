import { parse } from "@std/yaml";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createFrontmatterStore,
  extensionFields,
  extensionYaml,
  typeYaml,
} from "./document-frontmatter.ts";

Deno.test("preserves extension YAML and migrates existing citation references", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE okf_concept_sources (conceptId TEXT PRIMARY KEY, sources TEXT NOT NULL); INSERT INTO okf_concept_sources VALUES ('legacy', '[\"billing.md\"]')",
    );
    const store = createFrontmatterStore(db);
    assert.deepEqual(store.get("legacy"), { sources: ["billing.md"] });
    const fields = extensionFields(
      '---\ntype: Override\ntitle: Ignored\nid: ignored\nstatus: deprecated\ngenerated: spoofed\nintent: evidence\nsources: [{ resource: "billing.md", title: "Billing: rules" }]\ndescribes: ["src/**"]\nowner: Team\ntags: [one, two]\ndescription: "A: description"\nunknown: { nested: [true, 12, null] }\ncreated: 2026-10-31\n---\n\nBody',
    )!;
    assert.deepEqual(parse(typeYaml("Null")), { type: "Null" });
    assert.equal(fields.type, undefined);
    assert.equal(fields.intent, undefined);
    store.set("doc", fields);
    const reopened = createFrontmatterStore(db);
    assert.deepEqual(reopened.get("doc"), fields);
    assert.deepEqual(
      extensionFields(`---\n${extensionYaml(reopened.get("doc"))}---\nBody`),
      fields,
    );
    assert.equal(extensionFields("Body only"), null);
    assert.deepEqual(extensionFields("---\ntype: Guide\n---\nBody"), {});
    store.set("doc", {});
    assert.deepEqual(createFrontmatterStore(db).get("doc"), {});
    // A repeat startup cannot resurrect citations removed from the frontmatter.
    store.set("legacy", { sources: [] });
    assert.deepEqual(createFrontmatterStore(db).get("legacy"), { sources: [] });
  } finally {
    db.close();
  }
});

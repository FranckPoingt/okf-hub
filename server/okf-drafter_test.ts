import assert from "node:assert/strict";
import { parse } from "@std/yaml";
import {
  draftOkf,
  emptyOkfFolder,
  INPUT_LIMIT,
  repositoryInput,
} from "./okf-drafter.ts";
import { inspectOkf } from "./repository-source.ts";

Deno.test("draft evidence excludes secrets and symlinks and bounds files and input", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/docs`);
    await Deno.mkdir(`${root}/.github`);
    await Deno.writeTextFile(`${root}/README.md`, "Repository overview");
    for (
      const name of [
        ".env",
        "keys.md",
        "credentials.md",
        "private.md",
        "secrets.md",
        "cert.pem",
      ]
    ) {
      await Deno.writeTextFile(`${root}/docs/${name}`, "DO-NOT-SEND");
    }
    await Deno.writeTextFile(`${root}/.github/CODEOWNERS`, "* @platform");
    await Deno.symlink(`${root}/docs/secrets.md`, `${root}/docs/safe.md`);
    await Deno.writeTextFile(
      `${root}/docs/huge.md`,
      "x".repeat(INPUT_LIMIT * 2),
    );
    for (let i = 0; i < 40; i++) {
      await Deno.writeTextFile(
        `${root}/docs/guide-${i}.md`,
        "x".repeat(11_000),
      );
    }
    const input = await repositoryInput(root);
    assert(!JSON.stringify(input).includes("DO-NOT-SEND"));
    assert(!input.files.some((file) => /safe|huge/.test(file.path)));
    assert(input.files.length <= 32);
    assert(
      input.files.reduce((size, file) => size + file.content.length, 0) <=
        INPUT_LIMIT,
    );
    assert(input.files.some((file) => file.path === "README.md"));
    assert(await emptyOkfFolder(root, "okf"));
    await Deno.mkdir(`${root}/okf`);
    assert(await emptyOkfFolder(root, "okf"));
    await Deno.writeTextFile(`${root}/okf/index.md`, "existing");
    assert.equal(await emptyOkfFolder(root, "okf"), false);
    assert.equal(await emptyOkfFolder(root, "../outside"), false);
    await Deno.symlink(`${root}/docs`, `${root}/linked`);
    assert.equal(await emptyOkfFolder(root, "linked/missing"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("fake AI output is repaired with trusted provenance and invalid concepts dropped", async () => {
  const input = {
    files: [{ path: "README.md", content: "Overview" }],
    structure: [],
  };
  const result = await draftOkf(input, (request) => {
    assert.equal(request.task, "draft-okf");
    return Promise.resolve(JSON.stringify({
      concepts: [
        {
          path: "overview.md",
          type: "Overview",
          title: "Overview",
          body: "# Overview",
          sources: ["README.md", "invented.md"],
          generated: { by: "spoofed" },
        },
        {
          path: "../evil.md",
          type: "Guide",
          title: "Bad",
          body: "",
          sources: ["README.md"],
        },
        { path: "invalid.md", type: "", sources: [] },
        {
          path: "unknown.md",
          type: "Guide",
          title: "Unknown",
          body: "",
          sources: [".env"],
        },
      ],
    }));
  }, "test-model");
  assert.equal(result.files.length, 2);
  assert.equal(result.dropped, 3);
  assert(result.files[0].markdown.includes('okf_version: "0.2"'));
  const file = await inspectOkf(result.files[1].path, result.files[1].markdown);
  const metadata = parse(
    file.markdown.match(/^---\n([\s\S]*?)\n---/)![1],
  ) as Record<string, unknown>;
  assert.deepEqual(
    metadata.generated && (metadata.generated as { by: string }).by,
    "test-model",
  );
  assert.deepEqual(metadata.sources, [{ id: "repo-1", resource: "README.md" }]);
  for (
    const output of [
      "not json",
      '{"concepts":[]}',
      '{"concepts":[null]}',
      "x".repeat(100_001),
    ]
  ) {
    await assert.rejects(() =>
      draftOkf(input, () => Promise.resolve(output), "test")
    );
  }
});

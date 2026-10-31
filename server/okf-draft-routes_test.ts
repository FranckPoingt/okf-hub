import assert from "node:assert/strict";
import { createOkfDraftRoutes } from "./okf-draft-routes.ts";

Deno.test("draft routes enforce edit checks, review identity, ZIP approval and single use", async () => {
  const dataDir = await Deno.makeTempDir();
  const checkout = `${dataDir}/sources/repository`;
  await Deno.mkdir(checkout, { recursive: true });
  try {
    for (
      const args of [["init", "-q"], [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-qm",
        "initial",
      ]]
    ) {
      assert(
        (await new Deno.Command("git", {
          args,
          cwd: checkout,
          stdout: "null",
          stderr: "null",
        }).output()).success,
      );
    }
    await Deno.writeTextFile(`${checkout}/README.md`, "# Test component");
    let allowed = false;
    let configured = true;
    let actor = "editor";
    const checks: string[] = [];
    const events: string[] = [];
    let aiCalls = 0;
    const security = {
      session: () => Promise.resolve({ user: { id: actor } }),
      ensureImportedSource: () => Promise.resolve(),
      checkSpace: (_id: string, relation: string, space: string) => {
        checks.push(`${relation}:${space}`);
        return Promise.resolve(allowed);
      },
      audit: (_id: string, event: string) => events.push(event),
    } as unknown as Parameters<typeof createOkfDraftRoutes>[0]["security"];
    const routes = createOkfDraftRoutes({
      dataDir,
      security,
      repositorySource: () => ({
        folder: "okf",
        githubInstallationId: null,
        githubRepositoryId: null,
      }),
      refreshing: () => false,
      connectorEnabled: () => configured,
      app: null,
      model: "fake-model",
      responder: () => {
        aiCalls++;
        return Promise.resolve(
          JSON.stringify({
            concepts: [{
              path: "overview.md",
              type: "Overview",
              title: "Test",
              body: "# Test",
              sources: ["README.md"],
            }],
          }),
        );
      },
    });
    const request = (approve = false, draftId = "") =>
      routes.handle(
        new Request("http://localhost/api/draft", {
          method: "POST",
          body: JSON.stringify({ draftId }),
        }),
        "repository",
        approve,
      );
    assert.equal((await request()).status, 403);
    assert.equal(aiCalls, 0);
    assert.deepEqual(checks, ["edit:imported-repository"]);
    allowed = true;
    const response = await request();
    assert.equal(response.status, 200);
    const draft = await response.json();
    assert.equal(draft.files.length, 2);
    actor = "other-editor";
    assert.equal((await request(true, draft.draftId)).status, 400);
    actor = "editor";
    allowed = false;
    assert.equal((await request(true, draft.draftId)).status, 403);
    allowed = true;
    const zip = await request(true, draft.draftId);
    assert.equal(zip.status, 200);
    assert.equal(zip.headers.get("content-type"), "application/zip");
    assert((await zip.arrayBuffer()).byteLength > 0);
    assert.equal((await request(true, draft.draftId)).status, 400);
    assert(events.includes("source.okf-drafted"));
    assert(events.includes("source.okf-draft-exported"));
    configured = false;
    assert.equal((await request()).status, 409);
  } finally {
    await Deno.remove(dataDir, { recursive: true });
  }
});

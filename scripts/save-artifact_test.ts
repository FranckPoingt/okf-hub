/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { join } from "node:path";
import { packArtifact, parseArgs, saveArtifact } from "./save-artifact.ts";

const TOKEN = "test-only-scoped-key";
const HUB = "http://okf-hub.localhost";

async function fixture(run: (folder: string) => Promise<void>) {
  const folder = await Deno.makeTempDir();
  const previous = Deno.env.get("OKF_HUB_TOKEN");
  Deno.env.set("OKF_HUB_TOKEN", TOKEN);
  try {
    await Deno.writeTextFile(
      join(folder, "index.html"),
      "<button onclick=\"this.textContent='Done'\">Run</button>",
    );
    await Deno.writeTextFile(
      join(folder, "context.md"),
      "# Cost calculator\n\nPurpose and assumptions.\n",
    );
    await run(folder);
  } finally {
    if (previous === undefined) Deno.env.delete("OKF_HUB_TOKEN");
    else Deno.env.set("OKF_HUB_TOKEN", previous);
    await Deno.remove(folder, { recursive: true });
  }
}

function fakeHub() {
  let canPublish = true;
  let publishScopes = ["documents.publish", "apps.activate"];
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const documents = new Map<
    string,
    {
      id: string;
      spaceId: string;
      draft: string;
      workTraces: { summary: string }[];
    }
  >();
  const apps = new Map<
    string,
    {
      id: string;
      documentId: string;
      title: string;
      content: string;
      version: number;
      grants: unknown;
    }
  >();
  let failure: {
    name: string;
    status?: number;
    after?: boolean;
    message?: string;
  } | undefined;
  const request: typeof fetch = async (url, init) => {
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      `Bearer ${TOKEN}`,
    );
    assert.equal(init?.redirect, "error");
    if (init?.method === "GET") {
      calls.push({ name: "actions.list", input: {} });
      return Response.json({
        actions: publishScopes.map((name) => ({ name })),
      });
    }
    const name = new URL(String(url)).pathname.split("/").at(-1)!;
    const input = await new Response(init?.body).json() as Record<
      string,
      unknown
    >;
    calls.push({ name, input });
    const currentFailure = failure?.name === name ? failure : undefined;
    if (currentFailure) failure = undefined;
    if (currentFailure && !currentFailure.after) {
      return Response.json({ error: currentFailure.message ?? "Rejected" }, {
        status: currentFailure.status ?? 400,
      });
    }
    let result: unknown;
    switch (name) {
      case "spaces.list":
        result = [{ id: "tools", name: "Tools", canEdit: true }, {
          id: "private",
          name: "Private",
          canEdit: false,
        }];
        break;
      case "documents.create": {
        const id = `document-${documents.size + 1}`;
        const document = {
          id,
          spaceId: String(input.spaceId),
          draft: "",
          workTraces: [],
        };
        documents.set(id, document);
        result = document;
        break;
      }
      case "documents.get":
        result = documents.get(String(input.id));
        break;
      case "documents.update-draft": {
        const document = documents.get(String(input.id))!;
        document.draft = String(input.markdown);
        result = document;
        break;
      }
      case "apps.list":
        result = {
          canPublish,
          apps: [...apps.values()].filter((app) =>
            app.documentId === input.documentId
          ),
        };
        break;
      case "apps.create": {
        const id = `app-${apps.size + 1}`;
        const app = {
          id,
          documentId: String(input.documentId),
          title: String(input.title),
          content: String(input.content),
          version: 1,
          grants: input.grants,
        };
        apps.set(id, app);
        result = app;
        break;
      }
      case "apps.revise": {
        const app = apps.get(String(input.appId))!;
        app.content = String(input.content);
        app.version++;
        app.grants = input.grants;
        result = app;
        break;
      }
      case "documents.trace.create": {
        assert.match(String(input.occurredAt), /^\d{4}-\d{2}-\d{2}$/);
        const trace = { summary: String(input.summary) };
        documents.get(String(input.documentId))!.workTraces.push(trace);
        result = trace;
        break;
      }
      case "documents.publish":
        result = documents.get(String(input.id));
        break;
      case "apps.activate":
        result = apps.get(String(input.appId));
        break;
      default:
        throw new Error(`Unexpected action ${name}`);
    }
    if (currentFailure?.after) {
      throw new Error("Connection lost after mutation");
    }
    return Response.json({ result });
  };
  return {
    request,
    calls,
    documents,
    apps,
    setCanPublish: (value: boolean) => {
      canPublish = value;
    },
    setPublishScopes: (value: string[]) => {
      publishScopes = value;
    },
    fail: (value: NonNullable<typeof failure>) => {
      failure = value;
    },
  };
}

Deno.test("artifact save preserves IDs, revises content, and publishes only on request", async () => {
  await fixture(async (folder) => {
    const hub = fakeHub();
    const options = { folder, hubUrl: HUB, space: "Tools" };
    const first = await saveArtifact(options, hub.request);
    const repeated = await saveArtifact(options, hub.request);
    assert.equal(repeated.documentId, first.documentId);
    assert.equal(repeated.appId, first.appId);
    assert.equal(repeated.version, 1);
    assert.equal(hub.documents.size, 1);
    assert.equal(hub.apps.size, 1);
    assert.equal(
      hub.calls.filter((call) => call.name === "documents.trace.create").length,
      1,
    );
    assert.equal(
      hub.calls.some((call) =>
        call.name === "documents.publish" || call.name === "apps.activate"
      ),
      false,
    );
    assert.deepEqual(
      hub.calls.find((call) => call.name === "apps.create")!.input.grants,
      [],
    );
    assert.equal(
      hub.calls.find((call) => call.name === "documents.create")!.input.intent,
      "working",
    );
    assert.equal(first.documentUrl, `${HUB}/knowledge/${first.documentId}`);
    await Deno.writeTextFile(
      join(folder, "index.html"),
      "<h1>Version two</h1>",
    );
    const revised = await saveArtifact(options, hub.request);
    assert.equal(revised.appId, first.appId);
    assert.equal(revised.version, 2);
    assert.equal(hub.documents.get(first.documentId)!.workTraces.length, 2);
    assert.deepEqual(
      hub.calls.find((call) => call.name === "apps.revise")!.input.grants,
      [],
    );
    await saveArtifact({ ...options, publish: true }, hub.request);
    assert.deepEqual(hub.calls.slice(-2).map((call) => call.name), [
      "documents.publish",
      "apps.activate",
    ]);
    assert.equal(hub.apps.get(first.appId)!.version, 2);
  });
});

Deno.test("partial App rejection retries against the existing document", async () => {
  await fixture(async (folder) => {
    const hub = fakeHub();
    hub.fail({ name: "apps.create", status: 403 });
    const options = { folder, hubUrl: HUB, spaceId: "tools" };
    await assert.rejects(() => saveArtifact(options, hub.request), /Rejected/);
    const receipt = JSON.parse(
      await Deno.readTextFile(join(folder, ".okf-artifact.json")),
    );
    assert.equal(receipt.documentId, "document-1");
    assert.equal(receipt.appId, undefined);
    await saveArtifact(options, hub.request);
    assert.equal(hub.documents.size, 1);
    assert.equal(hub.apps.size, 1);
  });
});

Deno.test("lost App/revision/trace responses reconcile without duplicate work", async () => {
  await fixture(async (folder) => {
    const hub = fakeHub();
    const options = { folder, hubUrl: HUB };
    hub.fail({ name: "apps.create", after: true });
    await assert.rejects(
      () => saveArtifact(options, hub.request),
      /connection failed/,
    );
    const saved = await saveArtifact(options, hub.request);
    assert.equal(hub.apps.size, 1);
    await Deno.writeTextFile(join(folder, "index.html"), "<p>Changed</p>");
    hub.fail({ name: "apps.revise", after: true });
    await assert.rejects(
      () => saveArtifact(options, hub.request),
      /connection failed/,
    );
    hub.fail({ name: "documents.trace.create", after: true });
    await assert.rejects(
      () => saveArtifact(options, hub.request),
      /connection failed/,
    );
    await saveArtifact(options, hub.request);
    assert.equal(hub.apps.get(saved.appId)!.version, 2);
    assert.equal(hub.documents.get(saved.documentId)!.workTraces.length, 2);
  });
});

Deno.test("an ambiguous document creation blocks automatic duplicates and supports ID recovery", async () => {
  await fixture(async (folder) => {
    const hub = fakeHub();
    const options = { folder, hubUrl: HUB };
    hub.fail({ name: "documents.create", after: true });
    await assert.rejects(
      () => saveArtifact(options, hub.request),
      /connection failed/,
    );
    await assert.rejects(
      () => saveArtifact(options, hub.request),
      /outcome is unknown/,
    );
    assert.equal(
      hub.calls.filter((call) => call.name === "documents.create").length,
      1,
    );
    const path = join(folder, ".okf-artifact.json");
    const receipt = JSON.parse(await Deno.readTextFile(path));
    receipt.documentId = "document-1";
    await Deno.writeTextFile(path, JSON.stringify(receipt));
    await saveArtifact(options, hub.request);
    assert.equal(hub.documents.size, 1);
    assert.equal(hub.apps.size, 1);
  });
});

Deno.test("destination mismatches and unavailable saved Apps cannot silently create replacements", async () => {
  await fixture(async (folder) => {
    const hub = fakeHub();
    const saved = await saveArtifact({ folder, hubUrl: HUB }, hub.request);
    const mutations = () =>
      hub.calls.filter((call) =>
        !["spaces.list", "documents.get", "apps.list"].includes(call.name)
      ).length;
    const before = mutations();
    await assert.rejects(
      () =>
        saveArtifact({ folder, hubUrl: "http://other.localhost" }, hub.request),
      /different Hub/,
    );
    await assert.rejects(
      () =>
        saveArtifact({ folder, hubUrl: HUB, spaceId: "private" }, hub.request),
      /editable space/,
    );
    assert.equal(mutations(), before);
    hub.documents.get(saved.documentId)!.spaceId = "elsewhere";
    await assert.rejects(
      () => saveArtifact({ folder, hubUrl: HUB }, hub.request),
      /no longer/,
    );
    assert.equal(mutations(), before);
    hub.documents.get(saved.documentId)!.spaceId = "tools";
    hub.apps.delete(saved.appId);
    const originalDraft = hub.documents.get(saved.documentId)!.draft;
    await Deno.writeTextFile(
      join(folder, "context.md"),
      "# Replacement context\n",
    );
    await assert.rejects(
      () => saveArtifact({ folder, hubUrl: HUB }, hub.request),
      /will not replace/,
    );
    assert.equal(hub.documents.get(saved.documentId)!.draft, originalDraft);
    assert.equal(
      hub.calls.filter((call) => call.name === "apps.create").length,
      1,
    );
  });
});

Deno.test("packing excludes receipts and credential files, preserves local assets, and rejects symlinks", async () => {
  await fixture(async (folder) => {
    for (
      const name of [
        ".env",
        "credentials.json",
        "secret.json",
        "auth.json",
        "api-key.json",
        "secret.pem",
        ".okf-artifact.json",
      ]
    ) {
      await Deno.writeTextFile(join(folder, name), "SECRET_SENTINEL");
    }
    await Deno.writeTextFile(
      join(folder, "app.js"),
      "document.body.dataset.ready='yes'",
    );
    await Deno.writeTextFile(
      join(folder, "index.html"),
      '<script src="app.js"></script>',
    );
    const packed = await packArtifact(folder);
    const files =
      JSON.parse(packed.content.slice("okf-bundle-v1:".length)).files;
    assert.deepEqual(files.map((file: { path: string }) => file.path), [
      "app.js",
      "context.md",
      "index.html",
    ]);
    assert.equal(packed.content.includes(btoa("SECRET_SENTINEL")), false);
    await Deno.symlink(join(folder, "app.js"), join(folder, "linked.js"));
    await assert.rejects(() => packArtifact(folder), /Symlinks/);
  });
});

Deno.test("packing enforces self-contained dependencies and Hub resource limits", async () => {
  await fixture(async (folder) => {
    await Deno.writeTextFile(
      join(folder, "index.html"),
      '<script src="https://cdn.example/script.js"></script>',
    );
    await assert.rejects(() => packArtifact(folder), /included locally/);
    await Deno.writeTextFile(
      join(folder, "index.html"),
      "<script src=https://cdn.example/script.js></script>",
    );
    await assert.rejects(() => packArtifact(folder), /included locally/);
    await Deno.writeTextFile(
      join(folder, "index.html"),
      '<img srcset="https://cdn.example/a.png 1x">',
    );
    await assert.rejects(() => packArtifact(folder), /srcset/);
    await Deno.writeTextFile(
      join(folder, "index.html"),
      '<script type=module>import x from "./app.js"</script>',
    );
    await assert.rejects(() => packArtifact(folder), /module/i);
    await Deno.writeTextFile(
      join(folder, "index.html"),
      '<script src="app.js"></script>',
    );
    await Deno.writeTextFile(
      join(folder, "app.js"),
      'import x from "./external.js";',
    );
    await assert.rejects(() => packArtifact(folder), /module/i);
    await Deno.remove(join(folder, "app.js"));
    await Deno.writeTextFile(
      join(folder, "index.html"),
      '<script src="missing.js"></script>',
    );
    await assert.rejects(() => packArtifact(folder), /included locally/);
    await Deno.writeTextFile(
      join(folder, "index.html"),
      '<script>fetch("data.json")</script>',
    );
    await assert.rejects(() => packArtifact(folder), /Network APIs/);
    await Deno.writeTextFile(join(folder, "index.html"), "<p>Ready</p>");
    for (let index = 0; index < 199; index++) {
      await Deno.writeTextFile(join(folder, `${index}.txt`), "x");
    }
    await assert.rejects(() => packArtifact(folder), /200 files/);
  });
  await fixture(async (folder) => {
    await Deno.writeFile(
      join(folder, "large.png"),
      new Uint8Array(6 * 1024 * 1024),
    );
    await assert.rejects(() => packArtifact(folder), /Packed artifact exceeds/);
  });
});

Deno.test("CLI rejects token arguments and never escalates privileges after activation denial", async () => {
  assert.throws(
    () => parseArgs(["folder", "--token", "secret"]),
    /Unknown option/,
  );
  await fixture(async (folder) => {
    const hub = fakeHub();
    await assert.rejects(
      () =>
        saveArtifact({ folder, hubUrl: "http://remote.example" }, hub.request),
      /Use HTTPS/,
    );
    assert.equal(hub.calls.length, 0);
    hub.fail({
      name: "apps.activate",
      status: 403,
      message: `Owner access required ${TOKEN}`,
    });
    await assert.rejects(
      () => saveArtifact({ folder, hubUrl: HUB, publish: true }, hub.request),
      (error: Error) => {
        assert.equal(error.message.includes(TOKEN), false);
        assert.match(error.message, /Owner access required/);
        return true;
      },
    );
    assert.equal(
      hub.calls.some((call) =>
        /keys|members|groups|permissions/.test(call.name)
      ),
      false,
    );
  });
});

Deno.test("publish preflight preserves an existing artifact when the caller is not an owner", async () => {
  await fixture(async (folder) => {
    const hub = fakeHub();
    const saved = await saveArtifact({ folder, hubUrl: HUB }, hub.request);
    const draft = hub.documents.get(saved.documentId)!.draft;
    await Deno.writeTextFile(join(folder, "context.md"), "# Changed context\n");
    await Deno.writeTextFile(
      join(folder, "index.html"),
      "<p>Changed artifact</p>",
    );
    hub.setCanPublish(false);
    const before = hub.calls.length;
    await assert.rejects(
      () => saveArtifact({ folder, hubUrl: HUB, publish: true }, hub.request),
      /Owner access/,
    );
    assert.deepEqual(hub.calls.slice(before).map((call) => call.name), [
      "actions.list",
      "spaces.list",
      "documents.get",
      "apps.list",
    ]);
    assert.equal(hub.documents.get(saved.documentId)!.draft, draft);
    assert.equal(hub.apps.get(saved.appId)!.version, 1);
  });
});

Deno.test("missing publication scope fails before creating or changing Hub records", async () => {
  await fixture(async (folder) => {
    const hub = fakeHub();
    hub.setPublishScopes(["documents.publish"]);
    await assert.rejects(
      () => saveArtifact({ folder, hubUrl: HUB, publish: true }, hub.request),
      /scopes/,
    );
    assert.deepEqual(hub.calls.map((call) => call.name), ["actions.list"]);
    assert.equal(hub.documents.size, 0);
    assert.equal(hub.apps.size, 0);
    await assert.rejects(
      () => Deno.stat(join(folder, ".okf-artifact.json")),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("CLI --vendor packs rewritten dependencies and a deterministic manifest", async () => {
  assert.equal(parseArgs(["example", "--vendor"]).vendor, true);
  await fixture(async (folder) => {
    await Deno.writeTextFile(
      join(folder, "index.html"),
      '<script src="https://cdn.jsdelivr.net/npm/chart/dist/chart.umd.js"></script>',
    );
    const request: typeof fetch = () =>
      Promise.resolve(
        new Response("window.chart = 1;", {
          headers: { "content-type": "application/javascript" },
        }),
      );
    const first = await packArtifact(folder, true, request);
    const second = await packArtifact(folder, true, request);
    assert.equal(first.digest, second.digest);
    assert.equal(first.manifest.length, 1);
    assert.match(first.content, /vendor.json/);
    assert.equal(
      await Deno.readTextFile(join(folder, "index.html")),
      '<script src="https://cdn.jsdelivr.net/npm/chart/dist/chart.umd.js"></script>',
    );
  });
});

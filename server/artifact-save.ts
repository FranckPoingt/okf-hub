import {
  type ActionDefinition,
  ActionError,
  type createActionCatalog,
} from "./action-catalog.ts";
import {
  bundleContent,
  type BundleFile,
  encodeFile,
  MAX_BYTES,
  MAX_FILES,
  MIME,
  sha256,
  validateDependencies,
} from "./artifact-bundle.ts";
import { extname } from "node:path";

export function excluded(name: string) {
  return name.startsWith(".") || name === "node_modules" ||
    /^(?:credentials?|secrets?|tokens?|auth(?:entication)?|api[-_]?keys?)(?:[._-]|$)/i
      .test(name) ||
    /\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
}

export async function packArtifactFiles(
  entries:
    | AsyncIterable<{ path: string; bytes: Uint8Array }>
    | Iterable<{ path: string; bytes: Uint8Array }>,
  // Optional CLI step that adds local copies of CDN files before validation.
  vendor?: (files: BundleFile[]) => Promise<unknown[]>,
) {
  const files: BundleFile[] = [];
  let sourceBytes = 0;
  let markdown = "";
  for await (const { path, bytes } of entries) {
    if (path.split("/").some(excluded)) {
      throw new Error(`Excluded artifact file: ${path}`);
    }
    if (
      !path || path.startsWith("/") || path.includes("\\") ||
      path.includes("\0") || path.split("/").some((part) =>
        !part || part === "." || part === ".."
      )
    ) throw new Error("Artifact contains an unsafe filename");
    const type = MIME[extname(path).toLowerCase()];
    if (!type) throw new Error(`Unsupported static file: ${path}`);
    if (files.length >= MAX_FILES) {
      throw new Error(
        "Artifact exceeds 200 files",
      );
    }
    sourceBytes += bytes.length;
    if (sourceBytes > MAX_BYTES) throw new Error("Artifact exceeds 8 MiB");
    if (path === "context.md") markdown = new TextDecoder().decode(bytes);
    files.push(encodeFile(path, type, bytes));
  }
  if (!files.some((file) => file.path === "index.html")) {
    throw new Error("Artifact folder needs index.html");
  }
  if (!markdown.trim()) {
    throw new Error("Artifact folder needs non-empty context.md");
  }
  const manifest = vendor ? await vendor(files) : [];
  validateDependencies(files);
  const content = bundleContent(files);
  const digest = await sha256(new TextEncoder().encode(content));
  return { content, markdown, digest, manifest };
}

export type Receipt = {
  version: 1;
  hubUrl: string;
  spaceId: string;
  documentId?: string;
  appId?: string;
  pending?: "document" | "app";
  tracedDigest?: string;
};
type App = { id: string; content?: string; version: number; title: string };

export class HubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
export type InvokeArtifactAction = (
  name: string,
  input?: Record<string, unknown>,
  method?: string,
) => ReturnType<Response["json"]>;
export async function savePackedArtifact(
  { options, packed, title, hubUrl, initialReceipt, checkpoint, invoke }: {
    options: { space?: string; spaceId?: string; publish?: boolean };
    packed: Awaited<ReturnType<typeof packArtifactFiles>>;
    title: string;
    hubUrl: string;
    initialReceipt?: Receipt;
    checkpoint: (receipt: Receipt) => Promise<void>;
    invoke: InvokeArtifactAction;
  },
) {
  if (!title || title.length > 100) {
    throw new Error("Artifact title must be 1–100 characters");
  }
  let receipt = initialReceipt;
  const persist = () => checkpoint(receipt!);
  if (options.publish) {
    const actions = await invoke("", {}, "GET") as { name: string }[];
    if (
      !["documents.publish", "apps.activate"].every((name) =>
        actions.some((action) => action.name === name)
      )
    ) {
      throw new Error(
        "API key needs documents.publish and apps.activate scopes for --publish; no changes were saved",
      );
    }
  }
  const spaces = await invoke("spaces.list") as {
    id: string;
    name: string;
    canEdit: boolean;
  }[];
  const selected = options.spaceId
    ? spaces.filter((space) => space.id === options.spaceId && space.canEdit)
    : options.space
    ? spaces.filter((space) => space.name === options.space && space.canEdit)
    : receipt
    ? spaces.filter((space) => space.id === receipt!.spaceId && space.canEdit)
    : spaces.filter((space) => space.canEdit);
  if (selected.length !== 1) {
    throw new Error(
      "Choose exactly one editable space with --space or --space-id",
    );
  }
  const spaceId = selected[0].id;
  if (receipt && receipt.spaceId !== spaceId) {
    throw new Error(
      "Receipt belongs to a different space; use a separate artifact folder",
    );
  }
  receipt ??= { version: 1, hubUrl, spaceId };
  const create = async (
    stage: "document" | "app",
    name: string,
    input: Record<string, unknown>,
  ) => {
    receipt!.pending = stage;
    await persist();
    try {
      return await invoke(name, input);
    } catch (error) {
      if (
        error instanceof HubError &&
        [400, 401, 403, 404, 409, 413, 423].includes(error.status)
      ) {
        delete receipt!.pending;
        await persist();
      }
      throw error;
    }
  };
  if (!receipt.documentId) {
    if (receipt.pending === "document") {
      throw new Error(
        "Document creation outcome is unknown. Find the document in Hub, add its documentId to the recovery receipt (.okf-artifact.json for the CLI), and retry; no duplicate was created by this retry",
      );
    }
    const document = await create("document", "documents.create", {
      title,
      type: "Artifact",
      intent: "working",
      spaceId,
    });
    receipt.documentId = document.id;
    delete receipt.pending;
    await persist();
  } else {
    const document = await invoke("documents.get", { id: receipt.documentId });
    if (document.spaceId !== spaceId) {
      throw new Error("Saved document is no longer in the selected space");
    }
  }
  const appState = await invoke("apps.list", {
    documentId: receipt.documentId,
  });
  if (options.publish && appState.canPublish !== true) {
    throw new Error(
      "Owner access or space manager access is required to publish and activate this artifact; rerun without --publish to save a draft",
    );
  }
  const apps = (appState.apps ?? appState.artifacts ?? []) as App[];
  let app = receipt.appId
    ? apps.find((candidate) => candidate.id === receipt!.appId)
    : undefined;
  if (receipt.appId && !app) {
    throw new Error(
      "Saved App is unavailable; this command will not replace it",
    );
  }
  if (!app && receipt.pending === "app") {
    const matches = apps.filter((candidate) =>
      candidate.title === title && candidate.content === packed.content
    );
    if (matches.length !== 1) {
      throw new Error(
        "App creation outcome is unknown. Find its appId in Hub, add it to the recovery receipt (.okf-artifact.json for the CLI), and retry",
      );
    }
    app = matches[0];
  }
  await invoke("documents.update-draft", {
    id: receipt.documentId,
    markdown: packed.markdown,
  });
  if (!app) {
    app = await create("app", "apps.create", {
      documentId: receipt.documentId,
      title,
      type: "inline_html",
      content: packed.content,
      description:
        "Saved by an agent; purpose and sources are in the linked knowledge context.",
      grants: [],
    }) as App;
  } else if (app.content !== packed.content) {
    app = await invoke("apps.revise", {
      appId: app.id,
      content: packed.content,
      grants: [],
    }) as App;
  }
  receipt.appId = app.id;
  delete receipt.pending;
  await persist();
  if (receipt.tracedDigest !== packed.digest) {
    const document = await invoke("documents.get", { id: receipt.documentId });
    const marker = `Bundle SHA-256: ${packed.digest}`;
    if (
      !document.workTraces?.some((trace: { summary: string }) =>
        trace.summary.includes(marker)
      )
    ) {
      await invoke("documents.trace.create", {
        documentId: receipt.documentId,
        kind: "outcome",
        title: `Saved ${title}`.slice(0, 100),
        summary:
          `Saved Codex static artifact ${app.id}, version ${app.version}, with OKF context. ${marker}. No Hub capabilities granted. Vendored dependencies: ${
            packed.manifest.length
              ? `vendor.json (${packed.manifest.length} entries, covered by bundle SHA-256)`
              : "none"
          }.`,
        occurredAt: new Date().toISOString().slice(0, 10),
      });
    }
    receipt.tracedDigest = packed.digest;
    await persist();
  }
  if (options.publish) {
    await invoke("documents.publish", { id: receipt.documentId });
    await invoke("apps.activate", { appId: app.id });
  }
  return {
    documentId: receipt.documentId!,
    appId: app.id,
    version: app.version,
    documentUrl: `${hubUrl}/knowledge/${
      encodeURIComponent(receipt.documentId!)
    }`,
    published: options.publish === true,
  };
}

export const ARTIFACT_SAVE_SCOPES = [
  "spaces.list",
  "documents.create",
  "documents.get",
  "documents.update-draft",
  "documents.trace.create",
  "apps.list",
  "apps.create",
  "apps.revise",
];

export function artifactSaveAction(
  catalog: () => ReturnType<typeof createActionCatalog>,
): ActionDefinition {
  return {
    name: "artifact.save",
    tag: "Apps",
    title: "Save static artifact with context",
    description:
      "Save or revise a static App and its working OKF context. Retain the returned receipt for revisions. Requires artifact.save and the component action scopes. Draft by default; publication requires documents.publish and apps.activate plus owner access.",
    mode: "mutation",
    approval: "confirm",
    requiredScopes: ARTIFACT_SAVE_SCOPES,
    inputSchema: {
      type: "object",
      required: ["files"],
      additionalProperties: false,
      properties: {
        files: {
          type: "object",
          description:
            "Map of relative paths to UTF-8 text or base64 data URLs; must include index.html and non-empty context.md.",
        },
        title: { type: "string", maxLength: 100 },
        space: { type: "string" },
        spaceId: { type: "string" },
        publish: { type: "boolean" },
        receipt: {
          type: "object",
          required: ["version", "hubUrl", "spaceId"],
          additionalProperties: false,
          properties: {
            version: { enum: [1] },
            hubUrl: { type: "string" },
            spaceId: { type: "string" },
            documentId: { type: "string" },
            appId: { type: "string" },
            pending: { enum: ["document", "app"] },
            tracedDigest: { type: "string" },
          },
        },
      },
    },
    run: async (context, input) => {
      let receipt = input.receipt as Receipt | undefined;
      try {
        if (input.space && input.spaceId) {
          throw new Error("Choose space or spaceId");
        }
        if (receipt && receipt.hubUrl !== "") {
          throw new Error("Use the receipt returned by this Hub MCP action");
        }
        const files = input.files as Record<string, unknown>;
        const packed = await packArtifactFiles((function* () {
          for (
            const path of Object.keys(files).sort((a, b) => a.localeCompare(b))
          ) {
            const value = files[path];
            if (typeof value !== "string") {
              throw new Error("File contents must be strings");
            }
            let bytes: Uint8Array;
            if (value.startsWith("data:")) {
              const match = value.match(
                /^data:[^;,]+;base64,([A-Za-z0-9+/=]*)$/,
              );
              if (!match) {
                throw new Error("File data URL must be base64 encoded");
              }
              bytes = Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0));
            } else bytes = new TextEncoder().encode(value);
            yield { path, bytes };
          }
        })());
        const result = await savePackedArtifact({
          options: input,
          packed,
          title: input.title as string ??
            packed.markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "Artifact",
          hubUrl: "",
          initialReceipt: receipt,
          checkpoint: (next) => {
            receipt = next;
            return Promise.resolve();
          },
          invoke: async (name, args = {}, method) => {
            if (method === "GET") return catalog().list(context.scopes);
            try {
              return await catalog().invoke(
                name,
                context,
                args,
                context.scopes,
              );
            } catch (error) {
              if (error instanceof ActionError) {
                throw new HubError(error.message, error.status);
              }
              throw error;
            }
          },
        });
        return { ...result, receipt };
      } catch (error) {
        throw new ActionError(
          `${error instanceof Error ? error.message : "Artifact save failed"}${
            receipt
              ? `; retain this receipt to retry: ${JSON.stringify(receipt)}`
              : ""
          }`,
        );
      }
    },
  };
}

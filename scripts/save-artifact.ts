/// <reference lib="deno.ns" />

import { basename, extname, join, resolve } from "node:path";

const RECEIPT = ".okf-artifact.json";
const PREFIX = "okf-bundle-v1:";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 200;
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export type SaveArtifactOptions = {
  folder: string;
  hubUrl?: string;
  space?: string;
  spaceId?: string;
  title?: string;
  publish?: boolean;
};
type Receipt = {
  version: 1;
  hubUrl: string;
  spaceId: string;
  documentId?: string;
  appId?: string;
  pending?: "document" | "app";
  tracedDigest?: string;
};
type App = { id: string; content?: string; version: number; title: string };

function excluded(name: string) {
  return name.startsWith(".") || name === "node_modules" ||
    /^(?:credentials?|secrets?|tokens?|auth(?:entication)?|api[-_]?keys?)(?:[._-]|$)/i
      .test(name) ||
    /\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
}

export async function packArtifact(folder: string) {
  const root = resolve(folder);
  const info = await Deno.lstat(root);
  if (!info.isDirectory || info.isSymlink) {
    throw new Error("Artifact folder must be a real directory, not a symlink");
  }
  const files: { path: string; type: string; data: string }[] = [];
  let total = 0;
  let sourceBytes = 0;
  let markdown = "";
  const references: { path: string; target: string }[] = [];
  async function walk(directory: string, prefix = "") {
    const entries = [...Deno.readDirSync(directory)].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      const path = prefix + entry.name;
      if (entry.isSymlink) {
        throw new Error(`Symlinks are not supported: ${path}`);
      }
      if (excluded(entry.name)) continue;
      if (entry.name.includes("\\") || entry.name.includes("\0")) {
        throw new Error("Artifact contains an unsafe filename");
      }
      const diskPath = join(directory, entry.name);
      if (entry.isDirectory) {
        await walk(diskPath, `${path}/`);
        continue;
      }
      const stat = await Deno.lstat(diskPath);
      if (!stat.isFile || stat.isSymlink) {
        throw new Error(`Only regular files are supported: ${path}`);
      }
      const type = MIME[extname(entry.name).toLowerCase()];
      if (!type) throw new Error(`Unsupported static file: ${path}`);
      if (++total > MAX_FILES) throw new Error("Artifact exceeds 200 files");
      sourceBytes += stat.size;
      if (sourceBytes > MAX_BYTES) throw new Error("Artifact exceeds 8 MiB");
      const bytes = await Deno.readFile(diskPath);
      if (["text/html", "text/css", "text/javascript"].includes(type)) {
        const text = new TextDecoder().decode(bytes);
        if (
          /\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|import\s*\()/m
            .test(text)
        ) {
          throw new Error(
            `Network APIs and dynamic imports are unsupported in this static artifact: ${path}`,
          );
        }
        if (
          /\bimport\s+(?:["'{*]|[A-Za-z_$][\w$]*\s*(?:,|\bfrom\b))|\bexport\s+(?:\*|\{)/m
            .test(text)
        ) {
          throw new Error(
            `ES module imports are unsupported in this static artifact: ${path}`,
          );
        }
        if (type === "text/html") {
          for (
            const element of text.matchAll(
              /<(?:script|link|img|source|audio|video|iframe)\b[^>]*>/gi,
            )
          ) {
            for (
              const attribute of element[0].matchAll(
                /\b(src|href|poster|srcset|type)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi,
              )
            ) {
              const name = attribute[1].toLowerCase();
              const value = attribute[2] ?? attribute[3] ?? attribute[4];
              if (
                name === "srcset" ||
                (name === "type" && value.toLowerCase() === "module")
              ) {
                throw new Error(
                  `Module scripts and srcset are unsupported in this static artifact: ${path}`,
                );
              }
              if (name !== "type") references.push({ path, target: value });
            }
          }
        }
        if (type === "text/css" || type === "text/html") {
          for (
            const reference of text.matchAll(
              /url\(\s*["']?([^\s"')]+)["']?\s*\)/gi,
            )
          ) {
            references.push({ path, target: reference[1] });
          }
          if (/@import\b/i.test(text)) {
            throw new Error(
              `Bundle stylesheet imports locally before saving: ${path}`,
            );
          }
        }
      }
      if (path === "context.md") markdown = new TextDecoder().decode(bytes);
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(
          ...bytes.subarray(offset, offset + 0x8000),
        );
      }
      files.push({ path, type, data: `data:${type};base64,${btoa(binary)}` });
    }
  }
  await walk(root);
  if (!files.some((file) => file.path === "index.html")) {
    throw new Error("Artifact folder needs index.html");
  }
  if (!markdown.trim()) {
    throw new Error("Artifact folder needs non-empty context.md");
  }
  const paths = new Set(files.map((file) => file.path));
  for (const reference of references) {
    if (
      reference.target.startsWith("data:") || reference.target.startsWith("#")
    ) continue;
    const target = new URL(
      reference.target,
      `https://bundle.invalid/${reference.path}`,
    );
    if (
      target.origin !== "https://bundle.invalid" ||
      !paths.has(decodeURIComponent(target.pathname.slice(1)))
    ) {
      throw new Error(
        `Artifact dependency must be included locally: ${reference.path}`,
      );
    }
  }
  const content = PREFIX + JSON.stringify({ entry: "index.html", files });
  if (new TextEncoder().encode(content).length > MAX_BYTES) {
    throw new Error("Packed artifact exceeds the Hub's 8 MiB limit");
  }
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  const digest = [...new Uint8Array(hash)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return { root, content, markdown, digest };
}

function hubOrigin(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) || url.username ||
    url.password ||
    url.search || url.hash || url.pathname !== "/"
  ) {
    throw new Error(
      "Hub URL must be an HTTP(S) origin without credentials or a path",
    );
  }
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    !url.hostname.endsWith(".localhost")
  ) {
    throw new Error("Use HTTPS for a remote Hub, or a local .localhost URL");
  }
  return url.origin;
}

class HubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function saveArtifact(
  options: SaveArtifactOptions,
  request: typeof fetch = fetch,
) {
  const token = Deno.env.get("OKF_HUB_TOKEN");
  if (!token) throw new Error("Set OKF_HUB_TOKEN to a scoped Hub API key");
  const hubUrl = hubOrigin(options.hubUrl ?? Deno.env.get("OKF_HUB_URL") ?? "");
  if (options.space && options.spaceId) {
    throw new Error("Choose --space or --space-id");
  }
  const packed = await packArtifact(options.folder);
  const title = options.title ??
    packed.markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? basename(packed.root);
  if (!title || title.length > 100) {
    throw new Error("Artifact title must be 1–100 characters");
  }
  const receiptPath = join(packed.root, RECEIPT);
  let receipt: Receipt | undefined;
  try {
    const stat = await Deno.lstat(receiptPath);
    if (!stat.isFile || stat.isSymlink) {
      throw new Error("Receipt must be a regular file");
    }
    receipt = JSON.parse(await Deno.readTextFile(receiptPath));
    if (
      receipt?.version !== 1 || typeof receipt.spaceId !== "string" ||
      receipt.hubUrl !== hubUrl
    ) {
      throw new Error(
        "Receipt belongs to a different Hub or has an invalid format",
      );
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const checkpoint = async () => {
    const temporary = `${receiptPath}.tmp`;
    await Deno.writeTextFile(
      temporary,
      JSON.stringify(receipt, null, 2) + "\n",
      { mode: 0o600 },
    );
    await Deno.rename(temporary, receiptPath);
  };
  const invoke = async (
    name: string,
    input: Record<string, unknown> = {},
    method = "POST",
  ) => {
    let response: Response;
    try {
      response = await request(
        `${hubUrl}/api/v1/actions${name ? `/${name}` : ""}`,
        {
          method,
          redirect: "error",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: method === "POST" ? JSON.stringify(input) : undefined,
        },
      );
    } catch {
      throw new Error(
        `Hub connection failed during ${name}; the receipt preserves completed steps`,
      );
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof body.error === "string"
        ? body.error.split(token).join("[redacted]")
        : "Request failed";
      throw new HubError(
        `${name}: ${detail} (${response.status})`,
        response.status,
      );
    }
    return method === "GET" ? body.actions : body.result;
  };
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
    await checkpoint();
    try {
      return await invoke(name, input);
    } catch (error) {
      if (
        error instanceof HubError &&
        [400, 401, 403, 404, 409, 413, 423].includes(error.status)
      ) {
        delete receipt!.pending;
        await checkpoint();
      }
      throw error;
    }
  };
  if (!receipt.documentId) {
    if (receipt.pending === "document") {
      throw new Error(
        "Document creation outcome is unknown. Find the document in Hub, add its documentId to .okf-artifact.json, and retry; no duplicate was created by this retry",
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
    await checkpoint();
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
      "Owner access is required to publish and activate this artifact; rerun without --publish to save a draft",
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
        "App creation outcome is unknown. Find its appId in Hub, add it to .okf-artifact.json, and retry",
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
        "Created with Codex; purpose and sources are in the linked knowledge context.",
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
  await checkpoint();
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
          `Saved Codex static artifact ${app.id}, version ${app.version}, with OKF context. ${marker}. No Hub capabilities granted.`,
        occurredAt: new Date().toISOString().slice(0, 10),
      });
    }
    receipt.tracedDigest = packed.digest;
    await checkpoint();
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

export function parseArgs(args: string[]): SaveArtifactOptions {
  const options: SaveArtifactOptions = { folder: "" };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--publish") options.publish = true;
    else if (["--hub", "--space", "--space-id", "--title"].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`Value required for ${argument}`);
      }
      if (argument === "--hub") options.hubUrl = value;
      if (argument === "--space") options.space = value;
      if (argument === "--space-id") options.spaceId = value;
      if (argument === "--title") options.title = value;
    } else if (argument.startsWith("-") || options.folder) {
      throw new Error("Unknown option or extra folder argument");
    } else options.folder = argument;
  }
  if (!options.folder) {
    throw new Error(
      "Usage: save-artifact.ts <folder> [--hub URL] [--space NAME | --space-id ID] [--title TITLE] [--publish]",
    );
  }
  return options;
}

if (import.meta.main) {
  try {
    const result = await saveArtifact(parseArgs(Deno.args));
    console.log(
      `${
        result.published ? "Published" : "Saved draft"
      } App v${result.version}: ${result.documentUrl}`,
    );
  } catch (error) {
    const token = Deno.env.get("OKF_HUB_TOKEN");
    const message = error instanceof Error
      ? error.message
      : "Artifact save failed";
    console.error(token ? message.split(token).join("[redacted]") : message);
    Deno.exit(1);
  }
}

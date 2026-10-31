/// <reference lib="deno.ns" />

import { basename, join, resolve } from "node:path";

import {
  excluded,
  HubError,
  packArtifactFiles,
  type Receipt,
  savePackedArtifact,
} from "../server/artifact-save.ts";

import { vendorDependencies } from "./vendor-artifact.ts";

const RECEIPT = ".okf-artifact.json";
export type SaveArtifactOptions = {
  folder: string;
  hubUrl?: string;
  space?: string;
  spaceId?: string;
  title?: string;
  publish?: boolean;
  vendor?: boolean;
};
export async function packArtifact(
  folder: string,
  vendor = false,
  request: typeof fetch = fetch,
) {
  const root = resolve(folder);
  const info = await Deno.lstat(root);
  if (!info.isDirectory || info.isSymlink) {
    throw new Error("Artifact folder must be a real directory, not a symlink");
  }
  async function* walk(
    directory: string,
    prefix = "",
  ): AsyncGenerator<{ path: string; bytes: Uint8Array }> {
    const entries = [...Deno.readDirSync(directory)].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      const path = prefix + entry.name;
      if (entry.isSymlink) {
        throw new Error(`Symlinks are not supported: ${path}`);
      }
      if (excluded(entry.name)) continue;
      const diskPath = join(directory, entry.name);
      if (entry.isDirectory) {
        yield* walk(diskPath, `${path}/`);
        continue;
      }
      const stat = await Deno.lstat(diskPath);
      if (!stat.isFile || stat.isSymlink) {
        throw new Error(`Only regular files are supported: ${path}`);
      }
      if (stat.size > 8 * 1024 * 1024) {
        throw new Error("Artifact exceeds 8 MiB");
      }
      yield { path, bytes: await Deno.readFile(diskPath) };
    }
  }
  return {
    root,
    ...await packArtifactFiles(
      walk(root),
      vendor ? (files) => vendorDependencies(files, request) : undefined,
    ),
  };
}

export function hubOrigin(value: string) {
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
  const packed = await packArtifact(options.folder, options.vendor);
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
  return await savePackedArtifact({
    options,
    packed,
    title,
    hubUrl,
    initialReceipt: receipt,
    checkpoint: async (next) => {
      receipt = next;
      await checkpoint();
    },
    invoke,
  });
}

export function parseArgs(args: string[]): SaveArtifactOptions {
  const options: SaveArtifactOptions = { folder: "" };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--vendor") options.vendor = true;
    else if (argument === "--publish") options.publish = true;
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
      "Usage: save-artifact.ts <folder> [--hub URL] [--space NAME | --space-id ID] [--title TITLE] [--publish] [--vendor]",
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

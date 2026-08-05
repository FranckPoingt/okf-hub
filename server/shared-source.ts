/// <reference lib="deno.ns" />

import { createObjectStore } from "./object-store.ts";
import { inspectOkf, type RepositorySnapshot } from "./repository-source.ts";

const MAX_FILE_BYTES = 512 * 1024;

export type SharedSourceConfig = {
  endpoint: string;
  bucket: string;
  path: string;
  region: string;
  accessKey: string;
  secretKey: string;
};

async function revision(entries: { path: string; hash: string }[]) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(entries)),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function syncSharedSource(
  config: SharedSourceConfig,
): Promise<RepositorySnapshot> {
  const prefix = config.path ? `${config.path.replace(/\/+$/, "")}/` : "";
  const store = createObjectStore({
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
  });
  const objects = (await store.list(prefix)).filter(({ key }) => {
    const name = key.split("/").pop()?.toLowerCase() ?? "";
    return key.startsWith(prefix) && name.endsWith(".md") &&
      !["index.md", "log.md"].includes(name);
  }).sort((left, right) => left.key.localeCompare(right.key));
  const files = [];
  const issues = [];
  const entries = [];
  for (const object of objects) {
    const path = object.key.slice(prefix.length);
    if (!path || path.split("/").includes("..")) {
      issues.push({ path: object.key, error: "Unsafe object path" });
      continue;
    }
    if (object.size > MAX_FILE_BYTES) {
      issues.push({ path, error: "File exceeds 512 KiB" });
      entries.push({ path, hash: object.etag || String(object.size) });
      continue;
    }
    try {
      const markdown = await store.get(object.key);
      if (new TextEncoder().encode(markdown).byteLength > MAX_FILE_BYTES) {
        throw new Error("File exceeds 512 KiB");
      }
      const file = await inspectOkf(path, markdown);
      files.push(file);
      entries.push({ path, hash: file.hash });
    } catch (error) {
      issues.push({
        path,
        error: error instanceof Error ? error.message : "Could not read object",
      });
      entries.push({ path, hash: object.etag || String(object.size) });
    }
  }
  return { revision: await revision(entries), files, issues };
}

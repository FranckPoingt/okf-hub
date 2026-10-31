/// <reference lib="deno.ns" />
import { dirname, join, resolve } from "node:path";
import {
  type BundleFile,
  decodeFile,
  MAX_BYTES,
  MAX_FILES,
} from "../server/artifact-bundle.ts";
import { packArtifactFiles, type Receipt } from "../server/artifact-save.ts";
import { hubOrigin } from "./save-artifact.ts";

// Write only into a newly-created directory, so existing files and symlinks cannot
// redirect writes or leave stale files that would be included by the next save.
export async function pullArtifact(
  target: string,
  folder: string,
  request: typeof fetch = fetch,
) {
  const token = Deno.env.get("OKF_HUB_TOKEN");
  if (!token) throw new Error("Set OKF_HUB_TOKEN to a scoped Hub API key");
  let hubUrl: string;
  let documentId: string;
  if (/^https?:/.test(target)) {
    const url = new URL(target);
    hubUrl = hubOrigin(url.origin);
    const match = url.pathname.match(/^\/knowledge\/([^/]+)$/);
    if (!match || url.search || url.hash || url.username || url.password) {
      throw new Error("Use a Hub document URL");
    }
    documentId = decodeURIComponent(match[1]);
  } else {
    hubUrl = hubOrigin(Deno.env.get("OKF_HUB_URL") ?? "");
    documentId = target;
  }
  const response = await request(`${hubUrl}/api/v1/actions/artifact.get`, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ documentId }),
  });
  // Bound the encoded response before parsing, just as the MCP request is bounded.
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2 * MAX_BYTES) {
      await reader.cancel();
      throw new Error("Artifact response exceeds size limit");
    }
    chunks.push(value);
  }
  const payload = JSON.parse(await new Blob(chunks as BlobPart[]).text());
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error.split(token).join("[redacted]")
        : "Pull failed",
    );
  }
  const result = payload.result as {
    context: { spaceId: string };
    appId: string;
    digest: string;
    files: Record<string, { type: string; data: string }>;
  };
  const files: BundleFile[] = Object.entries(result.files).map((
    [path, file],
  ) => ({ path, type: file.type, data: file.data }));
  if (files.length > MAX_FILES) throw new Error("Artifact exceeds 200 files");
  const entries = files.map((file) => ({
    path: file.path,
    bytes: decodeFile(file),
  }));
  // Validate paths, excluded names, file types, dependencies and sizes before any writes.
  await packArtifactFiles(entries);
  const root = resolve(folder);
  await Deno.mkdir(root);
  try {
    for (const entry of entries) {
      const path = join(root, entry.path);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeFile(path, entry.bytes, { createNew: true });
    }
    const receipt: Receipt = {
      version: 1,
      hubUrl,
      spaceId: result.context.spaceId,
      documentId,
      appId: result.appId,
      tracedDigest: result.digest,
    };
    await Deno.writeTextFile(
      join(root, ".okf-artifact.json"),
      JSON.stringify(receipt, null, 2) + "\n",
      { createNew: true, mode: 0o600 },
    );
  } catch (error) {
    await Deno.remove(root, { recursive: true });
    throw error;
  }
  return { documentId, appId: result.appId, folder: root };
}
if (import.meta.main) {
  try {
    if (Deno.args.length !== 2) {
      throw new Error(
        "Usage: deno task artifact:pull <documentUrl-or-id> <new-directory>",
      );
    }
    const result = await pullArtifact(Deno.args[0], Deno.args[1]);
    console.log(`Pulled ${result.documentId} to ${result.folder}`);
  } catch (error) {
    const token = Deno.env.get("OKF_HUB_TOKEN");
    const message = error instanceof Error ? error.message : "Pull failed";
    console.error(token ? message.split(token).join("[redacted]") : message);
    Deno.exit(1);
  }
}

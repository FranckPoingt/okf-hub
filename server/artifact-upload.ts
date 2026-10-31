import { parse } from "@std/yaml";
import { inflateRawSync } from "node:zlib";
import { extname } from "node:path";
import {
  bundleContent,
  type BundleFile,
  encodeFile,
  fileText,
  MAX_BYTES,
  MAX_FILES,
  MIME,
  validateDependencies,
} from "./artifact-bundle.ts";

// Read central-directory lengths before inflating. No archive paths touch disk.
function unzip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (
    end >= Math.max(0, bytes.length - 65557) &&
    view.getUint32(end, true) !== 0x06054b50
  ) end--;
  if (end < 0 || end < bytes.length - 65557) {
    throw new Error("Invalid ZIP archive");
  }
  const count = view.getUint16(end + 10, true);
  if (count > MAX_FILES) throw new Error("Artifact exceeds 200 files");
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) {
    throw new Error("Split ZIP archives are unsupported");
  }
  let offset = view.getUint32(end + 16, true), total = 0;
  const files: BundleFile[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Invalid ZIP directory");
    }
    const flags = view.getUint16(offset + 8, true),
      method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true),
      size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true),
      extra = view.getUint16(offset + 30, true),
      comment = view.getUint16(offset + 32, true);
    const path = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    const mode = view.getUint32(offset + 38, true) >>> 16;
    const local = view.getUint32(offset + 42, true);
    offset += 46 + nameLength + extra + comment;
    if ((mode & 0xf000) === 0xa000) {
      throw new Error("ZIP symlinks are unsupported");
    }
    if (flags & 1) throw new Error("Encrypted ZIP archives are unsupported");
    if (path.endsWith("/")) continue;
    if (
      !path || path.includes("\\") || path.includes("\0") ||
      path.startsWith("/") || path.split("/").some((p) =>
        !p || p === "." || p === ".."
      )
    ) throw new Error("Unsafe ZIP file path");
    if (files.some((f) => f.path === path)) {
      throw new Error("Duplicate ZIP file path");
    }
    total += size;
    if (total > MAX_BYTES) throw new Error("Artifact exceeds 8 MiB");
    const type = MIME[extname(path).toLowerCase()];
    if (!type) throw new Error(`Unsupported static file: ${path}`);
    if (view.getUint32(local, true) !== 0x04034b50) {
      throw new Error("Invalid ZIP file header");
    }
    const start = local + 30 + view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    if (start + compressed > bytes.length) {
      throw new Error("Truncated ZIP file");
    }
    const source = bytes.subarray(start, start + compressed);
    const body = method === 0 ? source : method === 8
      ? new Uint8Array(
        inflateRawSync(source, { maxOutputLength: Math.max(1, size) }),
      )
      : null;
    if (!body || body.length !== size) {
      throw new Error("Unsupported or invalid ZIP compression");
    }
    files.push(encodeFile(path, type, body));
  }
  return files;
}
export function prepareArtifactUpload(
  name: string,
  bytes: Uint8Array,
  title = "",
  description = "",
) {
  if (bytes.length > MAX_BYTES) throw new Error("Upload exceeds 8 MiB");
  const files = /\.html$/i.test(name)
    ? [encodeFile("index.html", "text/html", bytes)]
    : /\.zip$/i.test(name)
    ? unzip(bytes)
    : null;
  if (!files) throw new Error("Choose a single .html file or .zip archive");
  if (!files.some((f) => f.path === "index.html")) {
    throw new Error("Artifact needs index.html at the archive root");
  }
  const context = files.find((f) => f.path === "context.md");
  let markdown = context ? fileText(context) : "";
  if (context && !markdown.trim()) {
    throw new Error("context.md must not be empty");
  }
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const metadata = frontmatter ? parse(frontmatter[1]) : null;
  const contextTitle =
    metadata && typeof metadata === "object" && "title" in metadata &&
      typeof metadata.title === "string"
      ? metadata.title
      : markdown.match(/^#\s+(.+)$/m)?.[1];
  title = (contextTitle ?? title).trim();
  if (!context && (!title || !description.trim())) {
    return { needsContext: true as const };
  }
  if (!title || title.length > 100) {
    throw new Error("Artifact title must be 1–100 characters");
  }
  if (!context) {
    markdown = `---\ntype: Artifact\ntitle: ${
      JSON.stringify(title)
    }\ndescription: ${
      JSON.stringify(description.trim().slice(0, 240))
    }\nstatus: draft\n---\n\n# ${title}\n\n${description.trim()}\n`;
    files.push(
      encodeFile(
        "context.md",
        "text/markdown",
        new TextEncoder().encode(markdown),
      ),
    );
  }
  if (new TextEncoder().encode(markdown).length > 512 * 1024) {
    throw new Error("context.md exceeds 512 KiB");
  }
  validateDependencies(files);
  return {
    needsContext: false as const,
    title,
    description,
    markdown,
    content: bundleContent(files),
  };
}

export async function readArtifactUpload(request: Request) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > MAX_BYTES) throw new Error("Upload exceeds 8 MiB");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

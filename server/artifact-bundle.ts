import { posix } from "node:path";

export type BundleFile = { path: string; type: string; data: string };
export const MAX_BYTES = 8 * 1024 * 1024;
export const MAX_FILES = 200;
export const PREFIX = "okf-bundle-v1:";
export const MIME: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".otf": "font/otf",
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
export function encodeFile(
  path: string,
  type: string,
  bytes: Uint8Array,
): BundleFile {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { path, type, data: `data:${type};base64,${btoa(binary)}` };
}
export function decodeFile(file: BundleFile) {
  return Uint8Array.from(
    atob(file.data.slice(file.data.indexOf(",") + 1)),
    (c) => c.charCodeAt(0),
  );
}
export function fileText(file: BundleFile) {
  return new TextDecoder().decode(decodeFile(file));
}
export async function sha256(bytes: Uint8Array) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    ),
  ].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export type Reference = { target: string; module?: boolean };
export function dependencies(text: string, type: string): Reference[] {
  const refs: Reference[] = [];
  if (type === "text/html") {
    for (
      const tag of text.matchAll(
        /<(?:script|link|img|source|audio|video|iframe|base|object|embed)\b[^>]*>/gi,
      )
    ) {
      for (
        const attr of tag[0].matchAll(
          /\b(src|href|poster|srcset|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi,
        )
      ) {
        if (attr[1].toLowerCase() === "srcset") {
          throw new Error("srcset is unsupported in this static artifact");
        }
        refs.push({ target: attr[2] ?? attr[3] ?? attr[4] });
      }
    }
  }
  if (type === "text/css" || type === "text/html") {
    for (const ref of text.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi)) {
      refs.push({ target: ref[1] });
    }
    for (const ref of text.matchAll(/@import\s+["']([^"']+)["']/gi)) {
      refs.push({ target: ref[1] });
    }
  }
  if (type === "text/javascript" || type === "text/html") {
    for (
      const ref of text.matchAll(
        /\bimport\s*(?:["']([^"']+)["']|[^;"'<>]*?\bfrom\s*["']([^"']+)["'])|\bexport\s*[^;"'<>]*?\bfrom\s*["']([^"']+)["']/g,
      )
    ) refs.push({ target: ref[1] ?? ref[2] ?? ref[3], module: true });
  }
  return refs;
}
export function validateDependencies(files: BundleFile[]) {
  const paths = new Set(files.map((f) => f.path));
  for (const file of files) {
    if (
      !/\.(?:html?|css|m?js|svg)$/i.test(file.path) &&
      !["text/html", "text/css", "text/javascript"].includes(file.type)
    ) continue;
    const text = fileText(file);
    if (
      /\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|import\s*\()/m.test(
        text,
      )
    ) {
      throw new Error(
        `Network APIs and dynamic imports are unsupported in this static artifact: ${file.path}. Use the CLI to bundle dependencies locally.`,
      );
    }
    for (
      const ref of dependencies(
        text,
        MIME[posix.extname(file.path).toLowerCase()] ?? file.type,
      )
    ) {
      if (ref.target.startsWith("data:") || ref.target.startsWith("#")) {
        continue;
      }
      const url = new URL(ref.target, `https://bundle.invalid/${file.path}`);
      if (
        url.origin !== "https://bundle.invalid" ||
        !paths.has(decodeURIComponent(url.pathname.slice(1))) ||
        (ref.module && !ref.target.startsWith("."))
      ) {
        throw new Error(
          `Artifact ${
            ref.module ? "ES module " : ""
          }dependency must be included locally: ${file.path} (${ref.target}). Use artifact:save <dir> --vendor on the saving machine, or bundle with the CLI.`,
        );
      }
    }
  }
}
export function bundleContent(files: BundleFile[]) {
  if (files.length > MAX_FILES) throw new Error("Artifact exceeds 200 files");
  const content = PREFIX + JSON.stringify({ entry: "index.html", files });
  if (new TextEncoder().encode(content).length > MAX_BYTES) {
    throw new Error("Packed artifact exceeds the Hub's 8 MiB limit");
  }
  return content;
}
export function relativeReference(from: string, to: string) {
  const path = posix.relative(posix.dirname(from), to);
  return path.startsWith(".") ? path : `./${path}`;
}

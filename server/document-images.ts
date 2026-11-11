/// <reference lib="deno.ns" />

import { ActionError } from "./action-catalog.ts";

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
// Hashed, app-root URLs keep Markdown portable across hosts and dedupe uploads.
export const IMAGE_ROUTE =
  /^\/api\/concepts\/([^/]+)\/images\/([0-9a-f]{64}\.(?:png|jpg|gif|webp))$/;
export const IMAGE_CSP = "default-src 'none'; sandbox";

const TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
} as const;

const starts = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte);
const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));

/** Identify an allowed raster image by its magic bytes; SVG is rejected. */
export function sniffImage(bytes: Uint8Array): keyof typeof TYPES | null {
  if (starts(bytes, [0x89, ...ascii("PNG\r\n\x1a\n")])) return "png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  if (starts(bytes, ascii("GIF87a")) || starts(bytes, ascii("GIF89a"))) {
    return "gif";
  }
  if (starts(bytes, ascii("RIFF")) && starts(bytes, ascii("WEBP"), 8)) {
    return "webp";
  }
  return null;
}

export const imageURL = (conceptId: string, name: string) =>
  `/api/concepts/${encodeURIComponent(conceptId)}/images/${name}`;

/** Image references to Hub-stored document images inside Markdown. */
export function imageReferences(markdown: string) {
  return Array.from(
    markdown.matchAll(
      /\/api\/concepts\/([^/\s)"'<>]+)\/images\/([0-9a-f]{64}\.(?:png|jpg|gif|webp))/g,
    ),
    (match) => ({
      url: match[0],
      conceptId: decodeURIComponent(match[1]),
      name: match[2],
    }),
  );
}

type BinaryStore = {
  putBytes(key: string, bytes: Uint8Array, type: string): Promise<void>;
  getBytes(key: string): Promise<Uint8Array | null>;
};

/** Uses the S3 store when configured, else files under the data directory. */
export function createImageStore(remote: BinaryStore | undefined, dir: string) {
  const key = (conceptId: string, name: string) =>
    `images/${encodeURIComponent(conceptId)}/${name}`;
  const local = (conceptId: string, name: string) =>
    `${dir}/${encodeURIComponent(conceptId)}/${name}`;
  return {
    async put(conceptId: string, bytes: Uint8Array) {
      const ext = sniffImage(bytes);
      if (!ext) {
        throw new ActionError("Upload a PNG, JPEG, GIF or WebP image", 415);
      }
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", bytes as BufferSource),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const name = `${hash}.${ext}`;
      if (remote) {
        await remote.putBytes(key(conceptId, name), bytes, TYPES[ext]);
      } else {
        const path = local(conceptId, name);
        const exists = await Deno.stat(path).then(() => true, () => false);
        if (!exists) {
          await Deno.mkdir(`${dir}/${encodeURIComponent(conceptId)}`, {
            recursive: true,
          });
          // Write then rename so a concurrent reader never sees partial bytes.
          const temporary = `${path}.${crypto.randomUUID()}.tmp`;
          await Deno.writeFile(temporary, bytes);
          await Deno.rename(temporary, path);
        }
      }
      return { name, url: imageURL(conceptId, name) };
    },
    async get(conceptId: string, name: string) {
      const ext = name.split(".").pop() as keyof typeof TYPES;
      const body = remote
        ? await remote.getBytes(key(conceptId, name))
        : await Deno.readFile(local(conceptId, name)).catch((error) => {
          if (error instanceof Deno.errors.NotFound) return null;
          throw error;
        });
      return body && TYPES[ext] ? { body, type: TYPES[ext] } : null;
    },
  };
}

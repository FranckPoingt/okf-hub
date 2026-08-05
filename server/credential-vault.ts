/// <reference lib="deno.ns" />

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PURPOSE = encoder.encode("okf-shared-source-v1");

function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

function unbase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function loadKey(dataDir: string) {
  const path = `${dataDir}/source-credentials.key`;
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    bytes = crypto.getRandomValues(new Uint8Array(32));
    await Deno.writeFile(path, bytes, { createNew: true, mode: 0o600 });
  }
  if (bytes.byteLength !== 32) {
    throw new Error("Source credential key must be 32 bytes");
  }
  const keyBytes = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function createCredentialVault(dataDir: string) {
  const key = await loadKey(dataDir);
  return {
    async encrypt(value: unknown) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: PURPOSE },
        key,
        encoder.encode(JSON.stringify(value)),
      );
      return `v1:${base64(iv)}:${base64(new Uint8Array(encrypted))}`;
    },
    async decrypt<T>(value: string): Promise<T> {
      const [version, encodedIv, encrypted] = value.split(":");
      if (version !== "v1" || !encodedIv || !encrypted) {
        throw new Error("Stored source credentials are invalid");
      }
      const plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: unbase64(encodedIv),
          additionalData: PURPOSE,
        },
        key,
        unbase64(encrypted),
      );
      return JSON.parse(decoder.decode(plain)) as T;
    },
  };
}

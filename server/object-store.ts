/// <reference lib="deno.ns" />

type StoreOptions = {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
};

const encoder = new TextEncoder();

function hex(value: ArrayBuffer | Uint8Array) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function buffer(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function sha256(value: string | Uint8Array) {
  return hex(
    await crypto.subtle.digest(
      "SHA-256",
      buffer(value),
    ),
  );
}

async function hmac(key: string | Uint8Array, value: string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    buffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      encoder.encode(value),
    ),
  );
}

function objectPath(bucket: string, key = "") {
  return `/${
    [bucket, ...key.split("/").filter(Boolean)].map(encodeURIComponent).join(
      "/",
    )
  }`;
}

export function createObjectStore({
  endpoint,
  accessKey,
  secretKey,
  bucket,
  region = "us-east-1",
}: StoreOptions) {
  const base = new URL(endpoint);

  async function request(method: "GET" | "PUT", key = "", body = "") {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const path = objectPath(bucket, key);
    const payloadHash = await sha256(body);
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalHeaders =
      `host:${base.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const canonical =
      `${method}\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const scope = `${date}/${region}/s3/aws4_request`;
    const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256(
      canonical,
    )}`;
    const dateKey = await hmac(`AWS4${secretKey}`, date);
    const regionKey = await hmac(dateKey, region);
    const serviceKey = await hmac(regionKey, "s3");
    const signingKey = await hmac(serviceKey, "aws4_request");
    const signature = hex(await hmac(signingKey, toSign));
    const response = await fetch(new URL(path, base), {
      method,
      body: method === "PUT" ? body : undefined,
      headers: {
        authorization:
          `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        ...(key && method === "PUT"
          ? { "content-type": "text/markdown; charset=utf-8" }
          : {}),
      },
    });
    return response;
  }

  let bucketReady = false;
  async function ensureBucket() {
    if (bucketReady) return;
    const response = await request("PUT");
    if (!response.ok && response.status !== 409) {
      throw new Error(
        `Object storage ${response.status}: ${await response.text()}`,
      );
    }
    bucketReady = true;
  }

  return {
    async put(key: string, markdown: string) {
      await ensureBucket();
      const response = await request("PUT", key, markdown);
      if (!response.ok) {
        throw new Error(
          `Object storage ${response.status}: ${await response.text()}`,
        );
      }
    },
    async get(key: string) {
      const response = await request("GET", key);
      if (!response.ok) {
        throw new Error(
          `Object storage ${response.status}: ${await response.text()}`,
        );
      }
      return response.text();
    },
  };
}

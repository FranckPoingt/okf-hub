import {
  bundleContent,
  type BundleFile,
  decodeFile,
  dependencies,
  encodeFile,
  fileText,
  MAX_BYTES,
  MAX_FILES,
  relativeReference,
  sha256,
} from "../server/artifact-bundle.ts";

const HOSTS = new Set([
  "cdn.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "esm.sh",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
]);
export type VendorRecord = { url: string; path: string; sha256: string };
function allowed(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" || !HOSTS.has(url.hostname) || url.username ||
    url.password || url.port
  ) throw new Error(`Vendoring URL is not allowed: ${value}`);
  return url;
}
// Never send Hub credentials; validate every redirect before following it.
async function download(value: string, request: typeof fetch) {
  let url = allowed(value);
  for (let i = 0; i < 6; i++) {
    const response = await request(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      url = allowed(new URL(response.headers.get("location") ?? "", url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Download failed (${response.status}): ${value}`);
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > MAX_BYTES) {
            throw new Error(`Download exceeds 8 MiB: ${value}`);
          }
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
    return {
      bytes,
      type: (response.headers.get("content-type") ?? "text/javascript").split(
        ";",
      )[0],
      url: url.href,
    };
  }
  throw new Error(`Too many redirects: ${value}`);
}
export async function vendorDependencies(
  files: BundleFile[],
  request: typeof fetch = fetch,
) {
  const originalCount = files.length;
  const records: VendorRecord[] = [];
  const cached = new Map<string, string>();
  async function vendor(value: string): Promise<string> {
    const url = allowed(value.replaceAll("&amp;", "&")).href;
    if (cached.has(url)) return cached.get(url)!;
    if (originalCount + new Set(cached.values()).size + 2 > MAX_FILES) {
      throw new Error("Artifact exceeds 200 files");
    }
    const result = await download(url, request);
    const digest = await sha256(result.bytes);
    const type = /(?:javascript|ecmascript)/.test(result.type)
      ? "text/javascript"
      : result.type;
    const ext = type === "text/css"
      ? "css"
      : type.includes("javascript")
      ? "js"
      : new URL(url).pathname.split(".").pop()?.match(/^(woff2?|ttf|otf)$/)
        ?.[0];
    if (!ext) {
      throw new Error(`Unsupported vendored content type ${type}: ${url}`);
    }
    const path = `vendor/${digest}.${ext}`;
    cached.set(url, path);
    let file = encodeFile(path, type, result.bytes);
    if (ext === "js" || ext === "css") {
      let text = fileText(file);
      const refs = dependencies(text, type);
      for (const ref of refs) {
        if (ref.target.startsWith("data:") || ref.target.startsWith("#")) {
          continue;
        }
        // Browsers cannot resolve bare specifiers without an import map.
        if (ext === "js" && !/^(?:\.{0,2}\/|https:)/.test(ref.target)) {
          throw new Error(
            `Bare import in vendored file ${url}: ${ref.target}. Use a browser ESM build such as esm.sh with target=es2022.`,
          );
        }
        const target = await vendor(new URL(ref.target, result.url).href);
        text = text.split(ref.target).join(relativeReference(path, target));
      }
      if (/\bimport\s*\(/.test(text)) {
        throw new Error(
          `Nested dynamic import in vendored file ${url}: ${
            text.match(/\bimport\s*\(\s*["']([^"']+)["']/)?.[1] ??
              "non-literal URL"
          }`,
        );
      }
      file = encodeFile(path, type, new TextEncoder().encode(text));
    }
    const existing = files.find((f) => f.path === path);
    if (existing && existing.data !== file.data) {
      throw new Error(`Vendored path collision: ${path}`);
    }
    if (!existing) files.push(file);
    records.push({ url, path, sha256: await sha256(decodeFile(file)) });
    bundleContent(files);
    return path;
  }
  for (const file of [...files]) {
    if (!["text/html", "text/css", "text/javascript"].includes(file.type)) {
      continue;
    }
    let text = fileText(file);
    for (const ref of dependencies(text, file.type)) {
      if (!/^(?:https?:)?\/\//i.test(ref.target)) continue;
      let source = ref.target.startsWith("//")
        ? `https:${ref.target}`
        : ref.target;
      // esm.sh serves Deno builds with node: imports to the CLI's user agent.
      if (
        new URL(source).hostname === "esm.sh" && !/[?&]target=/.test(source)
      ) {
        source += `${source.includes("?") ? "&" : "?"}target=es2022`;
      }
      const target = await vendor(source);
      text = text.split(ref.target).join(relativeReference(file.path, target));
    }
    Object.assign(
      file,
      encodeFile(file.path, file.type, new TextEncoder().encode(text)),
    );
  }
  if (records.length) {
    if (files.some((f) => f.path === "vendor.json")) {
      throw new Error(
        "vendor.json is reserved for the generated vendoring manifest",
      );
    }
    files.push(
      encodeFile(
        "vendor.json",
        "application/json",
        new TextEncoder().encode(JSON.stringify(records, null, 2) + "\n"),
      ),
    );
  }
  bundleContent(files);
  return records;
}

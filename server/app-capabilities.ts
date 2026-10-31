/// <reference lib="deno.ns" />

import { sha256 } from "./artifact-bundle.ts";

const TTL_MS = 10 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const APP_FILES_ROUTE = /^\/app-files\/([^/]*)(?:\/(.*))?$/;
export type AppCapability = { appId: string; version: number; userId: string };
type AppFile = { body: Uint8Array; type: string };

// Sandboxed Apps have an opaque origin, so their module fetches send
// `Origin: null` without cookies. A short-lived capability URL lets those
// fetches read one App version, and only that; it never carries credentials.
export function createAppCapabilities(now = () => Date.now(), ttlMs = TTL_MS) {
  const grants = new Map<string, AppCapability & { expiresAt: number }>();
  const digest = (token: string) => sha256(new TextEncoder().encode(token));
  const notFound = () =>
    new Response("App file not found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  return {
    async mint(grant: AppCapability) {
      for (const [key, value] of grants) {
        if (value.expiresAt <= now()) grants.delete(key);
      }
      const token = btoa(
        String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
      ).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      grants.set(await digest(token), { ...grant, expiresAt: now() + ttlMs });
      return token;
    },
    /** `open` must re-check the user's current access and the pinned version. */
    async serve(
      request: Request,
      token: string,
      path: string,
      open: (grant: AppCapability, path: string) => Promise<AppFile | null>,
      csp: string,
    ) {
      if (request.method !== "GET" || !TOKEN.test(token)) return notFound();
      const grant = grants.get(await digest(token));
      if (!grant || grant.expiresAt <= now()) return notFound();
      try {
        const file = await open(
          { appId: grant.appId, version: grant.version, userId: grant.userId },
          decodeURIComponent(path),
        );
        if (!file) return notFound();
        return new Response(file.body as BodyInit, {
          headers: {
            // Public on purpose: never add allow-credentials to this route.
            "access-control-allow-origin": "*",
            "content-type": file.type,
            "content-security-policy": csp,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          },
        });
      } catch {
        return notFound();
      }
    },
  };
}

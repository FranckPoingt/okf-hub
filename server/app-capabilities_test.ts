import assert from "node:assert/strict";
import { APP_FILES_ROUTE, createAppCapabilities } from "./app-capabilities.ts";

Deno.test("App capabilities serve one pinned version without credentials and expire", async () => {
  let clock = 0;
  const capabilities = createAppCapabilities(() => clock, 1000);
  const grant = { appId: "app", version: 2, userId: "user" };
  const token = await capabilities.mint(grant);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, await capabilities.mint(grant));
  const opened: unknown[] = [];
  const open = (received: typeof grant, path: string) => {
    opened.push([received, path]);
    if (path === "boom") throw new Error("Access revoked");
    return Promise.resolve(
      path === "app.js"
        ? {
          body: new TextEncoder().encode("export {}"),
          type: "text/javascript",
        }
        : null,
    );
  };
  const get = (path: string, init: RequestInit = {}) => {
    const route = new URL(path, "https://hub.test").pathname.match(
      APP_FILES_ROUTE,
    )!;
    return capabilities.serve(
      new Request(`https://hub.test${path}`, {
        ...init,
        headers: { origin: "null" },
      }),
      route[1],
      route[2] ?? "",
      open,
      "connect-src 'none'",
    );
  };

  const served = await get(`/app-files/${token}/app%2Ejs`);
  assert.equal(served.status, 200);
  assert.equal(await served.text(), "export {}");
  assert.equal(served.headers.get("access-control-allow-origin"), "*");
  assert.equal(served.headers.get("access-control-allow-credentials"), null);
  assert.equal(served.headers.get("content-type"), "text/javascript");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    served.headers.get("content-security-policy"),
    "connect-src 'none'",
  );
  assert.deepEqual(opened, [[grant, "app.js"]]);

  const missing = [
    await get(`/app-files/${token}/other.js`),
    await get(`/app-files/${token}/boom`),
    await get(`/app-files/${token}/%E0%A4%A`),
    await get(`/app-files/${"A".repeat(43)}/app.js`),
    await get(`/app-files/${token.slice(1)}/app.js`),
    await get("/app-files/"),
    await get(`/app-files/${token}/app.js`, { method: "POST" }),
  ];
  for (const response of missing) {
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "App file not found");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }

  clock = 1000;
  assert.equal((await get(`/app-files/${token}/app.js`)).status, 404);
});

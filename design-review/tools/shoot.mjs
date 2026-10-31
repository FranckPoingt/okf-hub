// Captures design-review screenshots from the seeded `okf-design` stack.
// Usage (Playwright installed outside the repo, e.g. /tmp/okf-design-pw):
//   NODE_PATH=/tmp/okf-design-pw/node_modules node design-review/tools/shoot.mjs <out-dir>
// ONLY=home,space limits the run to some shots.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const HUB = process.env.OKF_DESIGN_HUB ?? "http://localhost:18788";
const [out = "design-review/before"] = process.argv.slice(2);
const only = process.env.ONLY?.split(",");
mkdirSync(out, { recursive: true });

const viewports = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};
const users = {
  owner: "dana@acme.test",
  editor: "marcus@acme.test",
  viewer: "priya@acme.test",
};

async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
}

async function text(page, name) {
  return page.getByRole("button", { name }).or(page.getByRole("link", { name }))
    .first();
}

// Each shot navigates and optionally interacts; `user: null` is signed out.
const shots = [
  {
    name: "setup",
    user: null,
    path: "/?setup=design-review",
    // First-run state, mocked so it can be captured on a seeded stack.
    async before(page) {
      await page.route("**/api/bootstrap", (route) =>
        route.fulfill({
          json: {
            user: null,
            signupAllowed: true,
            setupTokenRequired: true,
            ssoProviders: [],
          },
        }));
    },
  },
  { name: "signin", user: null, path: "/" },
  { name: "home", path: "/" },
  {
    name: "search-results",
    path: "/search",
    async run(page) {
      await page.getByRole("searchbox").or(page.getByPlaceholder(/search/i))
        .first().fill("billing");
      await page.keyboard.press("Enter");
    },
  },
  {
    name: "search-empty",
    path: "/search",
    async run(page) {
      await page.getByRole("searchbox").or(page.getByPlaceholder(/search/i))
        .first().fill("zebra procurement");
      await page.keyboard.press("Enter");
    },
  },
  {
    name: "document-published",
    user: "viewer",
    path: "/knowledge/remote-work-policy",
  },
  {
    name: "document-stale",
    path: "/knowledge/use-postgres-for-the-billing-ledger",
  },
  { name: "document-conflict", path: "/knowledge/service-level-objective" },
  {
    name: "document-editor",
    path: "/knowledge/security-incident-response",
    async run(page) {
      await (await text(page, /^edit/i)).click().catch(() => {});
    },
  },
  {
    name: "draft-review",
    path: "/knowledge/security-incident-response",
    async run(page) {
      await (await text(page, /review|compare|changes/i)).click().catch(
        () => {},
      );
    },
  },
  {
    name: "artifact-first",
    path: "/knowledge/okf-hub-product-direction",
    async run(page) {
      await page.getByRole("button", { name: /view context/i }).first()
        .click();
    },
  },
  { name: "artifact-gallery", path: "/artifacts" },
  { name: "space", path: "/spaces/engineering" },
  { name: "space-empty", path: "/spaces/legal" },
  { name: "sources", path: "/sources" },
  {
    name: "imported-concept",
    path: "/imports/repository/services/billing-api.md",
  },
  { name: "connectors", path: "/settings/connectors" },
  {
    name: "source-access",
    path: "/sources",
    async run(page) {
      await page.locator("summary", { hasText: /^\s*Access\s*$/ }).first()
        .click();
      await page.locator("summary", { hasText: /^\s*Access\s*$/ }).first()
        .scrollIntoViewIfNeeded();
    },
  },
  { name: "settings-general", path: "/settings/general" },
  { name: "settings-members", path: "/settings/members" },
  { name: "developer-api", path: "/developer/api" },
  {
    name: "ask-unavailable",
    path: "/search",
    async run(page) {
      await page.getByRole("button", { name: /^ask okf$/i }).first().click();
    },
  },
];

const browser = await chromium.launch();
const sessions = {};
async function context(user, viewport, dark) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: dark ? "dark" : "light",
    storageState: user ? sessions[user] : undefined,
  });
  // Dark mode follows the browser color scheme set above.
  return ctx;
}

// Sign-in is rate limited, so sessions are cached between runs.
const cache = "/tmp/okf-design-sessions.json";
try {
  Object.assign(sessions, JSON.parse(readFileSync(cache, "utf8")));
} catch { /* first run */ }
for (const [role, email] of Object.entries(users)) {
  const ctx = await browser.newContext({ storageState: sessions[role] });
  if (
    (await ctx.request.get(`${HUB}/api/bootstrap`).then((r) => r.json()))
      .user
  ) {
    await ctx.close();
    continue;
  }
  for (let attempt = 0;; attempt++) {
    const response = await ctx.request.post(`${HUB}/api/auth/sign-in/email`, {
      data: { email, password: "acme-design-review" },
      headers: { origin: HUB },
    });
    if (response.ok()) break;
    if (response.status() !== 429 || attempt > 6) {
      throw new Error(`sign-in ${role}: ${response.status()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  sessions[role] = await ctx.storageState();
  await ctx.close();
}
writeFileSync(cache, JSON.stringify(sessions));

for (const shot of shots) {
  if (only && !only.includes(shot.name)) continue;
  for (const [vp, viewport] of Object.entries(viewports)) {
    for (const dark of [false, true]) {
      const user = shot.user === undefined ? "owner" : shot.user;
      const ctx = await context(user, viewport, dark);
      const page = await ctx.newPage();
      await shot.before?.(page);
      await page.goto(`${HUB}${shot.path}`);
      await settle(page);
      if (shot.run) {
        await shot.run(page);
        await settle(page);
      }
      const file = `${out}/${shot.name}-${vp}-${dark ? "dark" : "light"}.png`;
      await page.screenshot({ path: file });
      console.log(file);
      await ctx.close();
    }
  }
}
await browser.close();

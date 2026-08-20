export const SETTINGS_SECTIONS = [
  "general",
  "templates",
  "spaces",
  "members",
  "connectors",
  "developer",
] as const;

export type SettingsSection = typeof SETTINGS_SECTIONS[number];

export type AppRoute =
  | { kind: "home" }
  | { kind: "search" }
  | { kind: "sources" }
  | { kind: "developer" }
  | { kind: "space"; id: string }
  | { kind: "manage"; section: SettingsSection }
  | { kind: "concept"; id: string }
  | { kind: "imported"; sourceId: string; path: string }
  | { kind: "not_found" };

export function routePath(route: Exclude<AppRoute, { kind: "not_found" }>) {
  if (route.kind === "home") return "/";
  if (route.kind === "search") return "/search";
  if (route.kind === "sources") return "/sources";
  if (route.kind === "developer") return "/developer/api";
  if (route.kind === "space") return `/spaces/${encodeURIComponent(route.id)}`;
  if (route.kind === "manage") return `/settings/${route.section}`;
  if (route.kind === "concept") {
    return `/knowledge/${encodeURIComponent(route.id)}`;
  }
  return `/imports/${encodeURIComponent(route.sourceId)}/` +
    route.path.split("/").map(
      encodeURIComponent,
    ).join("/");
}

export function parseAppRoute(pathname: string): AppRoute {
  if (pathname === "/") return { kind: "home" };
  if (pathname === "/search") return { kind: "search" };
  if (pathname === "/sources") return { kind: "sources" };
  if (pathname === "/developer/api") return { kind: "developer" };
  if (pathname === "/settings" || pathname === "/manage") {
    return { kind: "manage", section: "general" };
  }
  const settings = pathname.match(/^\/settings\/([^/]+)$/);
  const space = pathname.match(/^\/spaces\/([^/]+)$/);
  const concept = pathname.match(/^\/knowledge\/([^/]+)$/);
  const imported = pathname.match(/^\/imports\/([^/]+)\/(.+)$/);
  try {
    if (settings) {
      const section = decodeURIComponent(settings[1]);
      return SETTINGS_SECTIONS.includes(section as SettingsSection)
        ? { kind: "manage", section: section as SettingsSection }
        : { kind: "not_found" };
    }
    if (space) {
      const id = decodeURIComponent(space[1]);
      return /^[a-z0-9-]+$/.test(id)
        ? { kind: "space", id }
        : { kind: "not_found" };
    }
    if (concept) return { kind: "concept", id: decodeURIComponent(concept[1]) };
    if (imported) {
      const sourceId = decodeURIComponent(imported[1]);
      if (!/^[a-z0-9-]+$/.test(sourceId)) return { kind: "not_found" };
      return {
        kind: "imported",
        sourceId,
        path: imported[2].split("/").map(decodeURIComponent).join("/"),
      };
    }
  } catch {
    return { kind: "not_found" };
  }
  return { kind: "not_found" };
}

export function resolveImportedLink(currentPath: string, href: string) {
  if (!href || href.startsWith("#")) return null;
  try {
    const target = new URL(href, `https://okf.invalid/${currentPath}`);
    if (target.origin !== "https://okf.invalid") return null;
    const path = decodeURIComponent(target.pathname.replace(/^\/+/, ""));
    return path && !path.endsWith("/") ? path : null;
  } catch {
    return null;
  }
}

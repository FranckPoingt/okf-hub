export type AppRoute =
  | { kind: "home" }
  | { kind: "search" }
  | { kind: "sources" }
  | { kind: "manage" }
  | { kind: "concept"; id: string }
  | { kind: "imported"; sourceId: "repository" | "shared"; path: string }
  | { kind: "not_found" };

export function routePath(route: Exclude<AppRoute, { kind: "not_found" }>) {
  if (route.kind === "home") return "/";
  if (route.kind === "search") return "/search";
  if (route.kind === "sources") return "/sources";
  if (route.kind === "manage") return "/manage";
  if (route.kind === "concept") {
    return `/knowledge/${encodeURIComponent(route.id)}`;
  }
  return `/imports/${route.sourceId}/` + route.path.split("/").map(
    encodeURIComponent,
  ).join("/");
}

export function parseAppRoute(pathname: string): AppRoute {
  if (pathname === "/") return { kind: "home" };
  if (pathname === "/search") return { kind: "search" };
  if (pathname === "/sources") return { kind: "sources" };
  if (pathname === "/manage") return { kind: "manage" };
  const concept = pathname.match(/^\/knowledge\/([^/]+)$/);
  const imported = pathname.match(/^\/imports\/(repository|shared)\/(.+)$/);
  try {
    if (concept) return { kind: "concept", id: decodeURIComponent(concept[1]) };
    if (imported) {
      return {
        kind: "imported",
        sourceId: imported[1] as "repository" | "shared",
        path: imported[2].split("/").map(decodeURIComponent).join("/"),
      };
    }
  } catch {
    return { kind: "not_found" };
  }
  return { kind: "not_found" };
}

import { resolveImportedLink, routePath } from "../routes.ts";

export type LinkDocument = {
  id: string;
  kind: "hub-native" | "imported";
  sourceId: string;
  path?: string;
};

export function portableKnowledgeLink(item: LinkDocument) {
  const path = item.kind === "hub-native" ? item.id : item.path!;
  return `okf://${item.sourceId}/${
    path.split("/").map(encodeURIComponent).join("/")
  }`;
}

// Only a caller's permission-filtered inventory may be passed here. Missing and
// inaccessible destinations deliberately have the same result.
export function resolveKnowledgeLink(
  current: LinkDocument,
  href: string,
  visible: readonly LinkDocument[],
) {
  let sourceId = current.sourceId;
  let path: string | null = null;
  const fragment = href.includes("#") ? href.slice(href.indexOf("#")) : "";
  if (/^okf:/i.test(href)) {
    const match = href.match(/^okf:\/\/([a-z0-9-]+)\/([^?#]+)(#[^\s]*)?$/);
    if (!match) return null;
    sourceId = match[1];
    try {
      path = match[2].split("/").map(decodeURIComponent).join("/");
    } catch {
      return null;
    }
    if (
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      path.includes("\\") ||
      Array.from(path).some((character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )
    ) return null;
  } else if (current.kind === "hub-native") {
    const match = href.match(/^\/knowledge\/([^/?#]+)(?:#[^\s]*)?$/);
    if (!match) return null;
    try {
      path = decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  } else if (current.path) {
    path = resolveImportedLink(current.path, href);
  }
  if (!path) return null;
  const target = visible.find((item) =>
    item.sourceId === sourceId &&
    (item.kind === "hub-native"
      ? item.id === path
      : item.path === path || item.path === `${path}.md`)
  );
  if (!target) return null;
  return {
    target,
    href: routePath(
      target.kind === "hub-native"
        ? { kind: "concept", id: target.id }
        : { kind: "imported", sourceId, path: target.path! },
    ) + fragment,
  };
}

export function isKnowledgeLink(href: string, imported = false) {
  return /^okf:/i.test(href) || href.startsWith("/knowledge/") ||
    (imported && Boolean(href) && !href.startsWith("#") &&
      !href.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(href));
}

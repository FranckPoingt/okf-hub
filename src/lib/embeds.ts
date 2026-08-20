export type EmbedPreview = {
  href: string;
  provider: "google-sheets" | "miro";
  title: string;
};

import { connectorDefinitions } from "./connectors.ts";

function googleSheets(url: URL): EmbedPreview | null {
  if (
    url.hostname !== "docs.google.com" ||
    !/^\/spreadsheets\/d\/(?:e\/)?[^/]+\/(?:edit|view|preview|pubhtml)\/?$/
      .test(
        url.pathname,
      )
  ) return null;

  url.pathname = url.pathname.replace(/\/(?:edit|view)\/?$/, "/preview");
  return {
    href: url.href,
    provider: "google-sheets",
    title: "Google Sheets",
  };
}

function miro(url: URL): EmbedPreview | null {
  if (
    !["miro.com", "www.miro.com"].includes(url.hostname) ||
    !/^\/app\/(?:board|live-embed)\/[^/]+\/?$/.test(url.pathname)
  ) return null;

  const boardId = url.pathname.match(
    /^\/app\/(?:board|live-embed)\/([^/]+)/,
  )?.[1];
  if (!boardId) return null;
  url.hostname = "miro.com";
  url.pathname = `/app/live-embed/${boardId}/`;
  if (!url.searchParams.has("embedMode")) {
    url.searchParams.set("embedMode", "view_only_without_ui");
  }
  if (!url.searchParams.has("autoplay")) {
    url.searchParams.set("autoplay", "true");
  }
  return { href: url.href, provider: "miro", title: "Miro" };
}

const providers = new Map([
  ["miro", miro],
  ["google-sheets", googleSheets],
]);
let enabledProviders = new Set(
  connectorDefinitions.filter((connector) =>
    connector.enabledByDefault && connector.capabilities.includes("embed")
  ).map((connector) => connector.id),
);

export function enableEmbedConnectors(ids: string[]) {
  enabledProviders = new Set(ids);
}

export function embedPreview(href: string): EmbedPreview | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  for (const [id, provider] of providers) {
    if (!enabledProviders.has(id)) continue;
    const preview = provider(new URL(url));
    if (preview) return preview;
  }
  return null;
}

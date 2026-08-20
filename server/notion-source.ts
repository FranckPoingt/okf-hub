/// <reference lib="deno.ns" />

import {
  inspectOkf,
  type RepositoryIssue,
  type RepositorySnapshot,
} from "./repository-source.ts";

// Adapted from Prismatic's Apache-2.0 Notion connector API conventions.
// See THIRD_PARTY_NOTICES.md.
const API = "https://api.notion.com/v1";
const VERSION = "2025-09-03";

export type NotionSourceConfig = { token: string };

type RichText = {
  plain_text?: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    code?: boolean;
  };
};

type NotionBlock = {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
};

type NotionPage = {
  id: string;
  archived?: boolean;
  in_trash?: boolean;
  last_edited_time: string;
  properties?: Record<string, { type?: string; title?: RichText[] }>;
};

type ListResponse<T> = {
  results?: T[];
  has_more?: boolean;
  next_cursor?: string | null;
};

function markdownText(items: RichText[] = []) {
  return items.map((item) => {
    let text = (item.plain_text ?? "").replaceAll("\\", "\\\\")
      .replace(/([`*_[\]<>])/g, "\\$1");
    if (item.annotations?.code) text = `\`${text.replaceAll("`", "\\`")}\``;
    if (item.annotations?.bold) text = `**${text}**`;
    if (item.annotations?.italic) text = `_${text}_`;
    if (item.annotations?.strikethrough) text = `~~${text}~~`;
    return item.href ? `[${text}](${item.href})` : text;
  }).join("");
}

function title(page: NotionPage) {
  const property = Object.values(page.properties ?? {}).find((item) =>
    item.type === "title"
  );
  return markdownText(property?.title).trim() || "Untitled";
}

function blockText(block: NotionBlock) {
  const value = block[block.type] as
    | {
      rich_text?: RichText[];
      caption?: RichText[];
      url?: string;
      language?: string;
      checked?: boolean;
    }
    | undefined;
  return { value, text: markdownText(value?.rich_text) };
}

function renderBlock(block: NotionBlock): string | null {
  const { value, text } = blockText(block);
  switch (block.type) {
    case "paragraph":
      return text;
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `- [${value?.checked ? "x" : " "}] ${text}`;
    case "quote":
      return `> ${text}`;
    case "callout":
      return `> ${text}`;
    case "code":
      return `\`\`\`${value?.language ?? ""}\n${text}\n\`\`\``;
    case "divider":
      return "---";
    case "equation":
      return `$$\n${
        String((block.equation as { expression?: string })?.expression ?? "")
      }\n$$`;
    case "bookmark":
    case "embed":
    case "link_preview": {
      const url = String(value?.url ?? "");
      return url ? `[${url}](${url})` : "";
    }
    case "image":
    case "video":
    case "file":
    case "pdf": {
      const media = value as {
        type?: "external" | "file";
        external?: { url?: string };
        file?: { url?: string };
        caption?: RichText[];
      };
      const url = media?.external?.url ?? media?.file?.url ?? "";
      const caption = markdownText(media?.caption) || block.type;
      return url
        ? (block.type === "image"
          ? `![${caption}](${url})`
          : `[${caption}](${url})`)
        : "";
    }
    case "child_page": {
      const child = block.child_page as { title?: string };
      return child?.title ? `- ${child.title}` : "";
    }
    case "table_of_contents":
      return "";
    default:
      return null;
  }
}

async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(
    new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function syncNotionSource(
  config: NotionSourceConfig,
  request: typeof fetch = fetch,
): Promise<RepositorySnapshot> {
  const headers = {
    authorization: `Bearer ${config.token}`,
    "content-type": "application/json",
    "notion-version": VERSION,
  };
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await request(`${API}${path}`, {
      ...init,
      headers: { ...headers, ...init?.headers },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as {
        message?: string;
      };
      throw new Error(body.message || `Notion returned ${response.status}`);
    }
    return await response.json() as T;
  };
  const list = async <T>(
    path: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>,
  ) => {
    const results: T[] = [];
    let cursor: string | null = null;
    do {
      const query: string = method === "GET"
        ? `${path}${path.includes("?") ? "&" : "?"}page_size=100${
          cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""
        }`
        : path;
      const page: ListResponse<T> = await call<ListResponse<T>>(query, {
        method,
        ...(method === "POST"
          ? {
            body: JSON.stringify({
              ...body,
              page_size: 100,
              ...(cursor ? { start_cursor: cursor } : {}),
            }),
          }
          : {}),
      });
      results.push(...(page.results ?? []));
      cursor = page.has_more ? page.next_cursor ?? null : null;
    } while (cursor);
    return results;
  };

  const pages = (await list<NotionPage>("/search", "POST", {
    filter: { property: "object", value: "page" },
    sort: { direction: "ascending", timestamp: "last_edited_time" },
  })).filter((page) => !page.archived && !page.in_trash)
    .sort((left, right) => left.id.localeCompare(right.id));
  const files = [];
  const issues: RepositoryIssue[] = [];
  const renderChildren = async (pageId: string, parentId = pageId) => {
    const blocks = await list<NotionBlock>(
      `/blocks/${parentId}/children`,
      "GET",
    );
    const rendered: string[] = [];
    for (const block of blocks) {
      const markdown = renderBlock(block);
      if (markdown === null) {
        issues.push({
          path: `${pageId}.md#${block.id}`,
          error: `Unsupported Notion block: ${block.type}`,
        });
      } else if (markdown) rendered.push(markdown);
      if (block.has_children) {
        rendered.push(...await renderChildren(pageId, block.id));
      }
    }
    return rendered;
  };
  for (const page of pages) {
    const rendered = await renderChildren(page.id);
    const pageTitle = title(page);
    const markdown = `---\ntype: Knowledge\ntitle: ${
      JSON.stringify(pageTitle)
    }\n---\n\n${rendered.join("\n\n")}\n`;
    files.push(await inspectOkf(`${page.id}.md`, markdown));
  }
  return {
    revision: await digest(
      pages.map((page) => [page.id, page.last_edited_time]),
    ),
    files,
    issues,
  };
}

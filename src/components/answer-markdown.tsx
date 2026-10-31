/** @jsxImportSource react */
import { remarkCtx } from "@milkdown/kit/core";
import { createElement, type ReactNode, useMemo } from "react";

// Reuse the editor's Markdown parser without mounting another editor or embeds.
const parser = remarkCtx.create(new Map()).get();
type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  depth?: number;
  ordered?: boolean;
  start?: number;
  url?: string;
  alt?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
};

export function safeAnswerHref(href: string): string | undefined {
  if (
    [...href].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  ) return;
  if (/^\/(?:knowledge|imports)\//.test(href) || href.startsWith("#")) {
    return href;
  }
  try {
    const url = new URL(href);
    if (["https:", "http:", "mailto:"].includes(url.protocol)) return url.href;
  } catch {
    // Unrecognised links remain readable text.
  }
}

function renderNode(
  node: MarkdownNode,
  key: string,
  source: string,
): ReactNode {
  const children = node.children?.map((child, index) =>
    renderNode(child, `${key}-${index}`, source)
  );
  switch (node.type) {
    case "root":
      return children;
    case "text":
      return node.value;
    case "paragraph":
      return <p key={key} className="my-2 first:mt-0 last:mb-0">{children}</p>;
    case "heading":
      return createElement(`h${node.depth ?? 2}`, {
        key,
        className: "mt-4 mb-2 font-semibold first:mt-0",
      }, children);
    case "strong":
      return <strong key={key}>{children}</strong>;
    case "emphasis":
      return <em key={key}>{children}</em>;
    case "inlineCode":
      return (
        <code
          key={key}
          className="rounded bg-background/70 px-1 py-0.5 text-xs"
        >
          {node.value}
        </code>
      );
    case "code":
      return (
        <pre
          key={key}
          className="my-3 overflow-x-auto rounded-md bg-background/70 p-3 text-xs"
        >
          <code>{node.value}</code>
        </pre>
      );
    case "list":
      return node.ordered
        ? (
          <ol
            key={key}
            start={node.start}
            className="my-2 list-decimal space-y-1 pl-5"
          >
            {children}
          </ol>
        )
        : (
          <ul key={key} className="my-2 list-disc space-y-1 pl-5">
            {children}
          </ul>
        );
    case "listItem":
      return <li key={key}>{children}</li>;
    case "blockquote":
      return (
        <blockquote
          key={key}
          className="my-3 border-l-2 pl-3 text-muted-foreground"
        >
          {children}
        </blockquote>
      );
    case "thematicBreak":
      return <hr key={key} className="my-3" />;
    case "break":
      return <br key={key} />;
    case "link": {
      const href = safeAnswerHref(node.url ?? "");
      return href
        ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            {children}
          </a>
        )
        : <span key={key}>{children}</span>;
    }
    case "image":
      // Model output must never load remote images or provider iframes.
      return <span key={key}>{node.alt || "[Image]"}</span>;
    default:
      // Raw HTML is inert React text; unsupported structures remain readable.
      return (
        <span key={key}>
          {children ?? node.value ??
            source.slice(
              node.position?.start.offset,
              node.position?.end.offset,
            )}
        </span>
      );
  }
}

export function AnswerMarkdown({ content }: { content: string }) {
  const nodes = useMemo(() => {
    try {
      return renderNode(
        parser.parse(content) as MarkdownNode,
        "answer",
        content,
      );
    } catch {
      return content;
    }
  }, [content]);
  return (
    <div className="min-w-0 whitespace-pre-wrap break-words text-sm leading-relaxed">
      {nodes}
    </div>
  );
}

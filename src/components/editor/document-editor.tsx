import { Crepe } from "@milkdown/crepe";
import {
  commandsCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  prosePluginsCtx,
} from "@milkdown/kit/core";
import { diffComponent } from "@milkdown/kit/component/diff";
import { diff, startDiffReviewCmd } from "@milkdown/kit/plugin/diff";
import { collab, collabServiceCtx } from "@milkdown/plugin-collab";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import {
  Decoration,
  DecorationSet,
  type EditorView,
} from "@milkdown/kit/prose/view";
import { Milkdown, useEditor } from "@milkdown/react";
import { useRef } from "react";
import * as Y from "yjs";
import {
  type Collaborator,
  type ConnectionStatus,
  DenoCollabProvider,
} from "../../collab-provider.ts";
import { api, conceptPath, SERVICE } from "../../lib/api.ts";
import { embedPreview } from "../../lib/embeds.ts";
import type { CommentThread } from "../../lib/models.ts";
import type { CommentSelection } from "./document-comments.tsx";

const withoutPageTitle = (markdown: string) =>
  markdown.replace(/^#\s+[^\n]*(?:\n|$)/, "");

const commentHighlightsKey = new PluginKey<DecorationSet>(
  "okf-comment-highlights",
);
const embedPreviewsKey = new PluginKey<DecorationSet>("okf-embed-previews");

function embedElement(
  href: string,
  editable: boolean,
  view: EditorView,
  getPos: () => number | undefined,
) {
  const preview = embedPreview(href)!;
  const figure = document.createElement("figure");
  figure.className = `okf-embed okf-embed-${preview.provider}`;

  const frame = document.createElement("iframe");
  frame.className = "okf-embed-frame";
  frame.src = preview.href;
  frame.title = `${preview.title} preview`;
  frame.loading = "lazy";
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  frame.allow = "fullscreen; clipboard-read; clipboard-write";
  frame.allowFullscreen = true;
  frame.setAttribute(
    "sandbox",
    "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts",
  );
  figure.append(frame);

  const caption = document.createElement("figcaption");
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = `Open in ${preview.title}`;
  caption.append(link);
  if (editable) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Edit link";
    button.addEventListener("click", () => {
      const after = getPos();
      const paragraph = after === undefined
        ? null
        : view.state.doc.resolve(after).nodeBefore;
      if (!paragraph || after === undefined) return;
      const start = after - paragraph.nodeSize + 1;
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(
            view.state.doc,
            start,
            start + paragraph.content.size,
          ),
        ),
      );
      view.focus();
    });
    caption.append(button);
  }
  figure.append(caption);
  return figure;
}

function embedDecorations(
  doc: ProseNode,
  selection: { from: number; to: number },
  editable: boolean,
) {
  const decorations: Decoration[] = [];
  // ponytail: this scans the document after edits; index embeds if huge pages
  // make the scan measurable.
  doc.descendants((node, position) => {
    if (node.type.name !== "paragraph" || node.childCount !== 1) return;
    const href = node.textContent.trim();
    if (href !== node.textContent || !embedPreview(href)) return;
    const after = position + node.nodeSize;
    if (
      editable && selection.from >= position + 1 && selection.from < after
    ) return;
    decorations.push(
      Decoration.node(position, after, { class: "okf-embed-source" }),
      Decoration.widget(
        after,
        (view, getPos) => embedElement(href, editable, view, getPos),
        {
          key: `okf-embed-${position}-${href}-${editable}`,
          side: -1,
          stopEvent: () => true,
        },
      ),
    );
  });
  return DecorationSet.create(doc, decorations);
}

function embedPlugin(editable: boolean) {
  return new Plugin<DecorationSet>({
    key: embedPreviewsKey,
    state: {
      init: (_, state) =>
        embedDecorations(state.doc, state.selection, editable),
      apply: (transaction, current) =>
        transaction.docChanged || transaction.selectionSet
          ? embedDecorations(
            transaction.doc,
            transaction.selection,
            editable,
          )
          : current,
    },
    props: {
      decorations: (state) => embedPreviewsKey.getState(state),
    },
  });
}

function commentRange(doc: ProseNode, thread: CommentThread) {
  const text = thread.anchorText.trim();
  const from = thread.anchorStart;
  const to = thread.anchorEnd;
  if (
    text && from !== null && to !== null && from < to &&
    to <= doc.content.size && doc.textBetween(from, to, " ").trim() === text
  ) return { from, to };

  // ponytail: duplicate quotes resolve to the first exact text node; use
  // persistent relative positions if ambiguous anchors become common.
  let found: { from: number; to: number } | null = null;
  if (text) {
    doc.descendants((node, position) => {
      if (found || !node.isText) return;
      const index = node.text?.indexOf(text) ?? -1;
      if (index >= 0) {
        found = { from: position + index, to: position + index + text.length };
      }
    });
  }
  return found;
}

function commentDecorations(doc: ProseNode, threads: CommentThread[]) {
  return DecorationSet.create(
    doc,
    threads.flatMap((thread) => {
      const range = commentRange(doc, thread);
      return range
        ? [
          Decoration.inline(range.from, range.to, {
            class: "comment-highlight",
            "data-comment-thread": thread.id,
            title: "Open comment",
            role: "button",
            tabindex: "0",
            "aria-label": "Open comment thread",
          }),
        ]
        : [];
    }),
  );
}

function commentPlugin(
  onSelection?: (selection: CommentSelection) => void,
  onOpen?: (threadId: string) => void,
) {
  let threads: CommentThread[] = [];
  const reportSelection = (view: EditorView) => {
    const { from, to, empty } = view.state.selection;
    const text = empty ? "" : view.state.doc.textBetween(from, to, " ").trim();
    if (!text) return onSelection?.(null);
    const end = view.coordsAtPos(to);
    onSelection?.({
      anchor: { text, from, to },
      top: end.bottom + 8,
      left: Math.min(end.left, globalThis.innerWidth - 128),
    });
  };
  const openThread = (view: EditorView, event: Event) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-comment-thread]")
      : null;
    const threadId = target?.dataset.commentThread;
    if (!threadId || !target || !view.dom.contains(target) || !onOpen) {
      return false;
    }
    onOpen(threadId);
    return true;
  };
  return new Plugin<DecorationSet>({
    key: commentHighlightsKey,
    state: {
      init: (_, state) => commentDecorations(state.doc, threads),
      apply: (transaction, current) => {
        const next = transaction.getMeta(commentHighlightsKey) as
          | CommentThread[]
          | undefined;
        if (next) {
          threads = next;
          return commentDecorations(transaction.doc, threads);
        }
        return transaction.docChanged
          ? commentDecorations(transaction.doc, threads)
          : current.map(transaction.mapping, transaction.doc);
      },
    },
    props: {
      decorations: (state) => commentHighlightsKey.getState(state),
      handleDOMEvents: {
        click: (view, event) => openThread(view, event),
        keydown: (view, event) => {
          if (event.key !== "Enter" && event.key !== " ") return false;
          const handled = openThread(view, event);
          if (handled) event.preventDefault();
          return handled;
        },
        mouseup: (view) => {
          queueMicrotask(() => reportSelection(view));
          return false;
        },
        keyup: (view) => {
          queueMicrotask(() => reportSelection(view));
          return false;
        },
      },
    },
  });
}

function previewLinkPlugin(onOpen: (href: string) => boolean) {
  return new Plugin({
    props: {
      handleDOMEvents: {
        click: (view, event) => {
          const link = event.target instanceof Element
            ? event.target.closest<HTMLAnchorElement>("a[href]")
            : null;
          const href = link?.getAttribute("href");
          if (!link || !href || !view.dom.contains(link) || !onOpen(href)) {
            return false;
          }
          event.preventDefault();
          return true;
        },
      },
    },
  });
}

function attachCommentHighlights(view: EditorView, conceptId: string) {
  let active = true;
  const refresh = async () => {
    const response = await api(
      `${conceptPath(conceptId)}/comments?status=open`,
    );
    if (!active || !response.ok) return;
    const threads = await response.json() as CommentThread[];
    if (active) {
      view.dispatch(view.state.tr.setMeta(commentHighlightsKey, threads));
    }
  };
  const onChange = (event: Event) => {
    if (
      (event as CustomEvent<{ conceptId?: string }>).detail?.conceptId ===
        conceptId
    ) void refresh();
  };
  globalThis.addEventListener("okf:comments-changed", onChange);
  void refresh();
  return () => {
    active = false;
    globalThis.removeEventListener("okf:comments-changed", onChange);
  };
}

export function DocumentPreview({
  markdown,
  hidePageTitle = true,
  conceptId,
  onCommentOpen,
  onLinkOpen,
}: {
  markdown: string;
  hidePageTitle?: boolean;
  conceptId?: string;
  onCommentOpen?: (threadId: string) => void;
  onLinkOpen?: (href: string) => boolean;
}) {
  const linkOpen = useRef(onLinkOpen);
  linkOpen.current = onLinkOpen;
  useEditor((root) => {
    let stopCommentHighlights = () => {};
    const crepe = new Crepe({
      root,
      defaultValue: hidePageTitle ? withoutPageTitle(markdown) : markdown,
      features: {
        [Crepe.Feature.AI]: false,
        [Crepe.Feature.ImageBlock]: false,
        [Crepe.Feature.TopBar]: false,
      },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: {
          mode: "doc",
          text: "Write something, or type / for commands",
        },
      },
    });
    crepe.editor.config((ctx) => {
      ctx.update(
        editorViewOptionsCtx,
        (options) => ({ ...options, editable: () => false }),
      );
      if (conceptId) {
        ctx.update(prosePluginsCtx, (plugins) => [
          ...plugins,
          commentPlugin(undefined, onCommentOpen),
        ]);
      }
      ctx.update(prosePluginsCtx, (plugins) => [
        ...plugins,
        embedPlugin(false),
        previewLinkPlugin((href) => linkOpen.current?.(href) ?? false),
      ]);
    });
    crepe.on((listener) =>
      listener.mounted((ctx) => {
        if (conceptId) {
          stopCommentHighlights = attachCommentHighlights(
            ctx.get(editorViewCtx),
            conceptId,
          );
        }
      })
    );
    const destroy = crepe.destroy;
    crepe.destroy = async () => {
      stopCommentHighlights();
      return await destroy();
    };
    return crepe;
  }, [conceptId, hidePageTitle, markdown, onCommentOpen]);
  return <Milkdown />;
}

export function RevisionDiff({
  before,
  after,
}: {
  before: string;
  after: string;
}) {
  useEditor((root) => {
    const crepe = new Crepe({
      root,
      defaultValue: before,
      features: {
        [Crepe.Feature.AI]: false,
        [Crepe.Feature.ImageBlock]: false,
        [Crepe.Feature.Placeholder]: false,
        [Crepe.Feature.TopBar]: false,
      },
    });
    crepe.editor.use(diff).use(diffComponent).config((ctx) => {
      ctx.update(
        editorViewOptionsCtx,
        (options) => ({ ...options, editable: () => false }),
      );
    });
    crepe.on((listener) =>
      listener.mounted((ctx) => {
        ctx.get(commandsCtx).call(startDiffReviewCmd.key, after);
      })
    );
    return crepe;
  }, [before, after]);
  return <Milkdown />;
}

export function LocalMarkdownEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (markdown: string) => void;
}) {
  useEditor((root) => {
    const crepe = new Crepe({
      root,
      defaultValue: value,
      features: {
        [Crepe.Feature.AI]: false,
        [Crepe.Feature.ImageBlock]: false,
        [Crepe.Feature.TopBar]: false,
      },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: {
          mode: "doc",
          text: "Write the reusable document structure…",
        },
      },
    });
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown, previous) => {
        if (markdown !== previous) onChange(markdown);
      });
    });
    return crepe;
  }, []);
  return <Milkdown />;
}

export function DocumentEditor({
  conceptId,
  collabEpoch,
  initialMarkdown,
  user,
  canEdit,
  onMarkdown,
  onStatus,
  onCollaborators,
  onReferenceReady,
  onCommentReady,
  onCommentSelection,
  onCommentOpen,
}: {
  conceptId: string;
  collabEpoch: number;
  initialMarkdown: string;
  user: Collaborator;
  canEdit: boolean;
  onMarkdown: (markdown: string) => void;
  onStatus: (status: ConnectionStatus) => void;
  onCollaborators: (users: Collaborator[]) => void;
  onReferenceReady?: (
    insert: ((title: string, href: string) => void) | null,
  ) => void;
  onCommentReady?: (
    read: (() => { text: string; from: number; to: number } | null) | null,
  ) => void;
  onCommentSelection?: (selection: CommentSelection) => void;
  onCommentOpen?: (threadId: string) => void;
}) {
  useEditor((root) => {
    const doc = new Y.Doc();
    const provider = new DenoCollabProvider(
      `${SERVICE.replace("http", "ws")}/collab?conceptId=${
        encodeURIComponent(conceptId)
      }&epoch=${collabEpoch}`,
      doc,
      user,
      onStatus,
      onCollaborators,
    );
    let editorConnected = false;
    let stopCommentHighlights = () => {};
    const crepe = new Crepe({
      root,
      features: {
        [Crepe.Feature.AI]: false,
        [Crepe.Feature.ImageBlock]: false,
        [Crepe.Feature.TopBar]: false,
      },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: {
          mode: "doc",
          text: "Write something, or type / for commands",
        },
      },
    });
    crepe.editor.use(collab).config((ctx) => {
      ctx.update(
        editorViewOptionsCtx,
        (options) => ({ ...options, editable: () => canEdit }),
      );
      ctx.update(prosePluginsCtx, (plugins) => [
        ...plugins,
        embedPlugin(canEdit),
        commentPlugin(onCommentSelection, onCommentOpen),
      ]);
    });
    crepe.on((listener) => {
      listener.mounted((ctx) => {
        const view = ctx.get(editorViewCtx);
        onCommentReady?.(() => {
          const { from, to, empty } = view.state.selection;
          if (empty) return null;
          return {
            text: view.state.doc.textBetween(from, to, " ").trim(),
            from,
            to,
          };
        });
        onReferenceReady?.((title, href) => {
          const link = view.state.schema.marks.link?.create({ href });
          const text = view.state.schema.text(title, link ? [link] : []);
          view.dispatch(
            view.state.tr.replaceSelectionWith(text).scrollIntoView(),
          );
          view.focus();
        });
        stopCommentHighlights = attachCommentHighlights(view, conceptId);
        const service = ctx.get(collabServiceCtx).bindDoc(doc).setAwareness(
          provider.awareness,
        );
        provider.onSynced(() => {
          if (editorConnected) return;
          service.applyTemplate(initialMarkdown).connect();
          const first = view.state.doc.firstChild;
          if (first?.type.name === "heading" && first.attrs.level === 1) {
            const transaction = view.state.tr;
            if (view.state.doc.childCount === 1) {
              transaction.replaceWith(
                0,
                first.nodeSize,
                view.state.schema.nodes.paragraph.create(),
              );
            } else {
              transaction.delete(0, first.nodeSize);
            }
            view.dispatch(transaction);
          }
          editorConnected = true;
        });
        provider.connect();
      });
      listener.markdownUpdated((_ctx, markdown, previous) => {
        if (canEdit && markdown !== previous) onMarkdown(markdown);
      });
    });
    const destroy = crepe.destroy;
    crepe.destroy = async () => {
      stopCommentHighlights();
      onCommentSelection?.(null);
      onReferenceReady?.(null);
      onCommentReady?.(null);
      provider.stop();
      try {
        return await destroy();
      } finally {
        provider.destroy();
      }
    };
    return crepe;
  }, [
    conceptId,
    collabEpoch,
    initialMarkdown,
    user.name,
    canEdit,
    onReferenceReady,
    onCommentReady,
    onCommentSelection,
    onCommentOpen,
  ]);
  return <Milkdown />;
}

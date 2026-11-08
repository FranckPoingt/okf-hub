import { Crepe } from "@milkdown/crepe";
import {
  commandsCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  prosePluginsCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import { diffComponent } from "@milkdown/kit/component/diff";
import { imageBlockSchema } from "@milkdown/kit/component/image-block";
import { diff, startDiffReviewCmd } from "@milkdown/kit/plugin/diff";
import { uploadConfig } from "@milkdown/kit/plugin/upload";
import { collab, collabServiceCtx } from "@milkdown/plugin-collab";
import { inputRules } from "@milkdown/kit/prose/inputrules";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import {
  Decoration,
  DecorationSet,
  type EditorView,
} from "@milkdown/kit/prose/view";
import { Milkdown, useEditor } from "@milkdown/react";
import { useRef, useState } from "react";
import * as Y from "yjs";
import {
  type Collaborator,
  type ConnectionStatus,
  DenoCollabProvider,
} from "../../collab-provider.ts";
import { api, conceptPath, SERVICE } from "../../lib/api.ts";
import { embedPreview } from "../../lib/embeds.ts";
import { insertReference } from "../../lib/insert-reference.ts";
import { markdownLinkRule } from "../../lib/link-input-rule.ts";
import { resolvePreviewLinks } from "../../lib/knowledge-preview.ts";
import type { CommentThread } from "../../lib/models.ts";
import type { CommentSelection } from "./document-comments.tsx";
import { MarkdownWritingHelp } from "./markdown-writing-help.tsx";

const withoutPageTitle = (markdown: string) =>
  markdown.replace(/^#\s+[^\n]*(?:\n|$)/, "");

type ImageUpload = (file: File) => Promise<string>;

/** Posts an image to the document's store; failures are reported and resolve
 * to "" so Crepe inserts nothing instead of a dead link. */
function imageUploader(
  conceptId: string | undefined,
  report: (message: string) => void,
): ImageUpload {
  return async (file) => {
    report("");
    try {
      if (!conceptId) {
        throw new Error(
          "Upload images inside a document; templates can use image URLs.",
        );
      }
      const response = await api(`${conceptPath(conceptId)}/images`, {
        method: "POST",
        body: file,
        headers: { "content-type": file.type || "application/octet-stream" },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          body.error ?? `Image upload failed (${response.status})`,
        );
      }
      return String(body.url);
    } catch (error) {
      report(
        `${file.name}: ${
          error instanceof Error ? error.message : "Image upload failed"
        }`,
      );
      return "";
    }
  };
}

/** Crepe with OKF's feature set: Ask replaces AI, and image blocks upload to
 * the document's image store. Omit `placeholder` on read-only surfaces. */
function createCrepe(
  root: HTMLElement,
  defaultValue: string,
  placeholder?: { mode: "doc" | "block"; text: string },
  upload: ImageUpload = () => Promise.resolve(""),
) {
  const crepe = new Crepe({
    root,
    defaultValue,
    features: {
      [Crepe.Feature.AI]: false,
      [Crepe.Feature.TopBar]: false,
      [Crepe.Feature.Placeholder]: Boolean(placeholder),
    },
    featureConfigs: {
      [Crepe.Feature.Placeholder]: placeholder,
      [Crepe.Feature.ImageBlock]: {
        onUpload: upload,
        blockCaptionPlaceholderText: "Describe the image (alt text)",
      },
    },
  });
  crepe.editor.config((ctx) => {
    // Pasted or dropped files go through the same uploader; failed ones are
    // skipped so no blob: or empty image lands in the Markdown.
    ctx.update(uploadConfig.key, (options) => ({
      ...options,
      uploader: async (files, schema) => {
        const images = Array.from(files).filter((file) =>
          file.type.startsWith("image/")
        );
        const urls = await Promise.all(images.map(upload));
        return urls.filter(Boolean).map((src) =>
          schema.nodes["image-block"].createAndFill({ src })!
        );
      },
    }));
    // Crepe stores the resize ratio in the alt text; keep standard
    // ![alt](url) Markdown and edit the alt text as the caption instead.
    // shortcut: resize ratio and image title are not persisted; store them
    // as attributes if users need sized images.
    ctx.update(imageBlockSchema.key, (schema) => (schemaCtx) => ({
      ...schema(schemaCtx),
      parseMarkdown: {
        match: ({ type }) => type === "image-block",
        runner: (state, node, type) => {
          state.addNode(type, {
            src: String(node.url ?? ""),
            caption: String(node.alt || node.title || ""),
            ratio: 1,
          });
        },
      },
      toMarkdown: {
        match: (node) => node.type.name === "image-block",
        runner: (state, node) => {
          state.openNode("paragraph");
          state.addNode("image", undefined, undefined, {
            url: node.attrs.src,
            alt: node.attrs.caption,
          });
          state.closeNode();
        },
      },
    }));
  });
  return crepe;
}

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
  linkTargets,
  imported = false,
}: {
  markdown: string;
  hidePageTitle?: boolean;
  conceptId?: string;
  onCommentOpen?: (threadId: string) => void;
  onLinkOpen?: (href: string) => boolean;
  linkTargets?: Record<string, string>;
  imported?: boolean;
}) {
  const linkOpen = useRef(onLinkOpen);
  linkOpen.current = onLinkOpen;
  useEditor((root) => {
    let stopCommentHighlights = () => {};
    const crepe = createCrepe(
      root,
      hidePageTitle ? withoutPageTitle(markdown) : markdown,
    ).setReadonly(true);
    crepe.editor.config((ctx) => {
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
        const view = ctx.get(editorViewCtx);
        view.dispatch(
          resolvePreviewLinks(view.state.tr, linkTargets ?? {}, imported),
        );
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
  }, [
    conceptId,
    hidePageTitle,
    imported,
    linkTargets,
    markdown,
    onCommentOpen,
  ]);
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
    const crepe = createCrepe(root, before).setReadonly(true);
    crepe.editor.use(diff).use(diffComponent);
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
  onSnapshotReady,
}: {
  value: string;
  onChange: (markdown: string) => void;
  onSnapshotReady?: (read: (() => string | null) | null) => void;
}) {
  const markdownChange = useRef(onChange);
  markdownChange.current = onChange;
  const snapshotReady = useRef(onSnapshotReady);
  snapshotReady.current = onSnapshotReady;
  const [uploadError, setUploadError] = useState("");
  useEditor((root) => {
    let editorMounted = false;
    const crepe = createCrepe(
      root,
      value,
      { mode: "doc", text: "Write the reusable document structure…" },
      imageUploader(undefined, setUploadError),
    );
    crepe.editor.config((ctx) => {
      ctx.update(prosePluginsCtx, (plugins) => [
        ...plugins,
        new Plugin({
          view: () => ({
            update: (view, previous) => {
              if (!editorMounted || previous.doc.eq(view.state.doc)) return;
              markdownChange.current(ctx.get(serializerCtx)(view.state.doc));
            },
          }),
        }),
      ]);
    });
    crepe.on((listener) => {
      listener.mounted(() => {
        editorMounted = true;
        snapshotReady.current?.(() =>
          editorMounted ? crepe.getMarkdown() : null
        );
      });
    });
    const destroy = crepe.destroy;
    crepe.destroy = async () => {
      editorMounted = false;
      snapshotReady.current?.(null);
      return await destroy();
    };
    return crepe;
  }, []);
  return (
    <>
      {uploadError && <p className="action-error" role="alert">{uploadError}
      </p>}
      <Milkdown />
    </>
  );
}

export function DocumentEditor({
  conceptId,
  collabEpoch,
  initialMarkdown,
  user,
  canEdit,
  onMarkdown,
  onSnapshotReady,
  onLoaded,
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
  onSnapshotReady?: (read: (() => string | null) | null) => void;
  /** The editor's own serialization of the opened document, before any edit. */
  onLoaded?: (markdown: string) => void;
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
  const markdownChange = useRef(onMarkdown);
  markdownChange.current = onMarkdown;
  const snapshotReady = useRef(onSnapshotReady);
  snapshotReady.current = onSnapshotReady;
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;
  const [ready, setReady] = useState(false);
  const [uploadError, setUploadError] = useState("");
  useEditor((root) => {
    setReady(false);
    let emitted = "";
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
    // Block mode hints on whichever empty line holds the cursor, not only an
    // empty document; viewers who cannot edit get no writing prompt.
    const crepe = createCrepe(
      root,
      "",
      canEdit
        ? { mode: "block", text: "Write something, or type / for commands" }
        : undefined,
      canEdit ? imageUploader(conceptId, setUploadError) : undefined,
    );
    crepe.editor.use(collab).config((ctx) => {
      ctx.update(
        editorViewOptionsCtx,
        (options) => ({
          ...options,
          editable: () => canEdit && editorConnected,
        }),
      );
      ctx.update(prosePluginsCtx, (plugins) => [
        ...plugins,
        embedPlugin(canEdit),
        inputRules({ rules: [markdownLinkRule] }),
        commentPlugin(onCommentSelection, onCommentOpen),
      ]);
    });
    crepe.on((listener) => {
      listener.mounted((ctx) => {
        const view = ctx.get(editorViewCtx);
        snapshotReady.current?.(() =>
          editorConnected ? crepe.getMarkdown() : null
        );
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
          // Opening must not look like an edit: the title strip and Markdown
          // normalization above are the baseline, not a change.
          emitted = crepe.getMarkdown();
          loaded.current?.(emitted);
          view.setProps({ editable: () => canEdit && editorConnected });
          onCommentReady?.(() => {
            const { from, to, empty } = view.state.selection;
            if (empty) return null;
            return {
              text: view.state.doc.textBetween(from, to, " ").trim(),
              from,
              to,
            };
          });
          onReferenceReady?.((title, href) =>
            insertReference(view, title, href)
          );
          setReady(true);
        });
        provider.connect();
      });
      listener.markdownUpdated((_ctx, markdown) => {
        if (editorConnected && canEdit && markdown !== emitted) {
          emitted = markdown;
          markdownChange.current(markdown);
        }
      });
    });
    const destroy = crepe.destroy;
    crepe.destroy = async () => {
      editorConnected = false;
      snapshotReady.current?.(null);
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
  return (
    <div className="document-writing-surface" aria-busy={!ready}>
      {ready
        ? <MarkdownWritingHelp />
        : (
          <p className="px-1 py-2 text-sm text-muted-foreground" role="status">
            Connecting to document…
          </p>
        )}
      {uploadError && <p className="action-error" role="alert">{uploadError}
      </p>}
      <div inert={!ready}>
        <Milkdown />
      </div>
    </div>
  );
}

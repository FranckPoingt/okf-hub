import type { Transaction } from "@milkdown/kit/prose/state";
import { isKnowledgeLink } from "./knowledge-links.ts";

// Apply to the read-only preview only. The source Markdown and CRDT never change.
export function resolvePreviewLinks(
  transaction: Transaction,
  targets: Record<string, string>,
  imported: boolean,
) {
  transaction.doc.descendants((node, position) => {
    if (!node.isInline) return;
    for (const mark of node.marks) {
      if (mark.type.name !== "link") continue;
      const href = String(mark.attrs.href ?? "");
      if (!isKnowledgeLink(href, imported)) continue;
      transaction.removeMark(position, position + node.nodeSize, mark);
      if (Object.hasOwn(targets, href)) {
        transaction.addMark(
          position,
          position + node.nodeSize,
          mark.type.create({ ...mark.attrs, href: targets[href] }),
        );
      }
    }
  });
  return transaction;
}

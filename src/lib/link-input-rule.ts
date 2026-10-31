import { InputRule } from "@milkdown/kit/prose/inputrules";
import type { EditorState } from "@milkdown/kit/prose/state";

// Typing the closing ")" of `[label](url)` turns the text into a link. `![` is left for images.
export const markdownLinkPattern = /(?<!!)\[([^\]\n]+)\]\(([^)\s]+)\)$/;

export function markdownLinkHandler(
  state: EditorState,
  match: RegExpMatchArray,
  start: number,
  end: number,
) {
  const link = state.schema.marks.link;
  const [, label, href] = match;
  // Same scheme guard as rendered answer links: no script-bearing URLs.
  if (!link || /^\s*(?:javascript|data|vbscript):/i.test(href)) return null;
  return state.tr
    .replaceWith(start, end, state.schema.text(label, [link.create({ href })]))
    .removeStoredMark(link);
}

export const markdownLinkRule = new InputRule(
  markdownLinkPattern,
  markdownLinkHandler,
);

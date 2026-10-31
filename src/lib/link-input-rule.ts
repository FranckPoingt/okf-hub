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
  // Allowlist schemes; anything else (javascript:, data:, obfuscated forms) stays text.
  if (!link || !/^(?:https?:|mailto:|okf:|[/#.?]|[^:]*$)/i.test(href)) {
    return null;
  }
  return state.tr
    .replaceWith(start, end, state.schema.text(label, [link.create({ href })]))
    .removeStoredMark(link);
}

export const markdownLinkRule = new InputRule(
  markdownLinkPattern,
  markdownLinkHandler,
);

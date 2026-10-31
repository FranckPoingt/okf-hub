import type { EditorState, Transaction } from "@milkdown/kit/prose/state";

export function insertReference(
  view: {
    state: EditorState;
    dispatch: (transaction: Transaction) => void;
    focus: () => void;
  },
  title: string,
  href: string,
) {
  const link = view.state.schema.marks.link?.create({ href });
  const text = view.state.schema.text(title, link ? [link] : []);
  // false: keep the link mark instead of adopting the marks at the cursor.
  view.dispatch(
    view.state.tr.replaceSelectionWith(text, false).scrollIntoView(),
  );
  view.focus();
}

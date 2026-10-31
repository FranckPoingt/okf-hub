export type RetrievalResult = {
  id: string;
  kind: "hub-native" | "imported";
  sourceId: string;
  sourceLabel: string;
  title: string;
  path?: string;
};

export type Citation = {
  n: number;
  documentId: string;
  title: string;
  sourceLabel: string;
  url: string;
};

// Search is supplied by the caller so that its existing permission filter is
// the only way a document can enter the context.
export async function retrieveKnowledge(
  question: string,
  search: (query: string) => Promise<RetrievalResult[]>,
  load: (result: RetrievalResult) => Promise<string | null>,
  budget = 24_000,
) {
  const terms = [
    ...new Set(question.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []),
  ]
    .filter((term) =>
      !new Set([
        "the",
        "and",
        "what",
        "how",
        "are",
        "for",
        "about",
        "with",
        "from",
        "does",
        "our",
        "this",
      ]).has(term)
    )
    .slice(0, 12).map((term) => term.slice(0, 120));
  const matches = new Map<string, { item: RetrievalResult; score: number }>();
  for (const term of terms) {
    for (const item of await search(term)) {
      const existing = matches.get(item.id);
      if (existing) existing.score++;
      else matches.set(item.id, { item, score: 1 });
    }
  }
  const ranked = [...matches.values()].sort((a, b) =>
    b.score - a.score || a.item.title.localeCompare(b.item.title)
  ).slice(0, 8);
  const citations: Citation[] = [];
  let context = "";
  for (const { item } of ranked) {
    const body = await load(item);
    if (!body) continue;
    const n = citations.length + 1;
    const header = `[${n}] ${item.title} (${item.sourceLabel})\n`;
    const remaining = budget - context.length - header.length - 2;
    if (remaining <= 0) break;
    context += `${header}${body.slice(0, Math.min(4_000, remaining))}\n\n`;
    citations.push({
      n,
      documentId: item.id,
      title: item.title,
      sourceLabel: item.sourceLabel,
      url: item.kind === "hub-native"
        ? `/knowledge/${encodeURIComponent(item.id)}`
        : `/imports/${encodeURIComponent(item.sourceId)}/${
          (item.path ?? "").split("/").map(encodeURIComponent).join("/")
        }`,
    });
  }
  return { context, citations };
}

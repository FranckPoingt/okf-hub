import type { AIMessage, AIResponder } from "./ai.ts";

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

export type SemanticMatch = { item: RetrievalResult; excerpt: string };

/** Asks the chat provider for search terms. Only the conversation is sent,
 * never document content; callers fall back to keywords on any failure. */
export async function searchTerms(
  respond: AIResponder,
  messages: AIMessage[],
  timeoutMs = 8_000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      respond({
        task: "search-terms",
        messages: messages.slice(-6),
        document: { title: "", space: "", state: "source", markdown: "" },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    const parsed = JSON.parse(
      answer.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
    );
    const terms = [
      ...new Set(
        (Array.isArray(parsed) ? parsed : parsed?.terms)
          .filter((term: unknown) => typeof term === "string")
          .map((term: string) => term.trim().slice(0, 120))
          .filter(Boolean),
      ),
    ] as string[];
    if (!terms.length) throw new Error("No search terms");
    return terms.slice(0, 10);
  } finally {
    clearTimeout(timer);
  }
}

// Both rankers are supplied by the caller and must use its existing permission
// filter. Load rechecks access and returns only the current permitted content.
export async function retrieveKnowledge(
  question: string,
  search: (query: string) => Promise<RetrievalResult[]>,
  load: (result: RetrievalResult) => Promise<string | null>,
  budget = 24_000,
  semantic?: (question: string) => Promise<SemanticMatch[]>,
  rewrite?: (question: string) => Promise<string[]>,
) {
  const keywords = [
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
  let rewritten: string[] = [];
  try {
    rewritten = await rewrite?.(question) ?? [];
  } catch {
    // Bad JSON, provider errors and timeouts keep keyword-only retrieval.
  }
  const terms = [
    ...new Set([
      ...rewritten.map((term) => term.toLocaleLowerCase()),
      ...keywords,
    ]),
  ];
  const matches = new Map<string, { item: RetrievalResult; score: number }>();
  for (const term of terms) {
    // Matched terms dominate; each list's BM25 order breaks ties.
    for (const [rank, item] of (await search(term)).entries()) {
      const score = 1 + 1 / (rank + 2);
      const existing = matches.get(item.id);
      if (existing) existing.score += score;
      else matches.set(item.id, { item, score });
    }
  }
  let ranked = [...matches.values()].sort((a, b) =>
    b.score - a.score || a.item.title.localeCompare(b.item.title)
  );
  const excerpts = new Map<string, string>();
  let semanticMatches: SemanticMatch[] = [];
  try {
    semanticMatches = await semantic?.(question) ?? [];
  } catch {
    // A failed optional ranker preserves the exact lexical ordering.
  }
  if (semanticMatches.length) {
    const fused = new Map<string, { item: RetrievalResult; score: number }>();
    ranked.forEach(({ item }, rank) =>
      fused.set(item.id, { item, score: 1 / (60 + rank + 1) })
    );
    semanticMatches.forEach(({ item, excerpt }, rank) => {
      const previous = fused.get(item.id);
      fused.set(item.id, {
        item,
        score: (previous?.score ?? 0) + 1 / (60 + rank + 1),
      });
      excerpts.set(item.id, excerpt);
    });
    ranked = [...fused.values()].sort((a, b) =>
      b.score - a.score || a.item.title.localeCompare(b.item.title)
    );
  }
  ranked = ranked.slice(0, 8);
  const citations: Citation[] = [];
  let context = "";
  for (const { item } of ranked) {
    let body = await load(item);
    if (!body) continue;
    const excerpt = excerpts.get(item.id);
    // Never use cached chunk text unless it still occurs in the permitted body.
    if (excerpt && body.includes(excerpt)) body = excerpt;
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

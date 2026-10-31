import { ActionError } from "./action-catalog.ts";
import type { AIMessage, AIResponder } from "./ai.ts";
import {
  type RetrievalResult,
  retrieveKnowledge,
  searchTerms,
} from "./knowledge-retrieval.ts";
import { searchState } from "./search-index.ts";
import type { createSemanticIndex } from "./semantic-index.ts";

type VisibleDocument = RetrievalResult & {
  canEdit?: boolean;
  status?: string;
  publishedRevision?: number | null;
};
type Concept = {
  id: string;
  spaceId: string;
  status: string;
  publishedRevision: number | null;
};

// Both the UI and catalog call this path. Candidate filtering precedes the
// retrieval budget, and load rechecks permissions and publication visibility.
export function createWorkspaceAsk<
  C extends Concept,
  V extends { documents: VisibleDocument[] },
>(deps: {
  respondWithAI: AIResponder | null | undefined;
  visibleSearchDocuments: (
    userId: string,
    includeArchived: boolean,
  ) => Promise<V>;
  searchKnowledge: (
    userId: string,
    input: Record<string, unknown>,
    visible: V,
  ) => Promise<{ results: RetrievalResult[] }>;
  concept: (id: string) => C | undefined;
  space: (id: string) => { name: string } | undefined;
  importedConcepts: () => { id: string; objectKey: string }[];
  security: {
    check: (
      userId: string,
      relation: "view" | "edit",
      id: string,
    ) => Promise<boolean>;
    audit: (userId: string, action: string, object: string) => unknown;
  };
  store: { get: (key: string) => Promise<string> };
  withoutFrontmatter: (markdown: string) => string;
  payload: (
    row: C,
    canEdit: boolean,
    userId: string,
  ) => Promise<{ draft: string | null; published: string | null }>;
  semanticIndex: ReturnType<typeof createSemanticIndex> | null | undefined;
}) {
  const {
    respondWithAI,
    visibleSearchDocuments,
    searchKnowledge,
    concept,
    space,
    importedConcepts,
    security,
    store,
    withoutFrontmatter,
    payload,
    semanticIndex,
  } = deps;
  return async function askWorkspace(userId: string, messages: AIMessage[]) {
    if (!respondWithAI) throw new ActionError("Ask OKF is not configured", 503);
    const visible = await visibleSearchDocuments(userId, false);
    const { context, citations } = await retrieveKnowledge(
      messages.at(-1)!.content,
      async (query) =>
        (await searchKnowledge(userId, { query }, visible))
          .results.map((item) => {
            const row = item.kind === "hub-native" ? concept(item.id) : null;
            return row
              ? {
                ...item,
                sourceLabel: space(row.spaceId)?.name ?? row.spaceId,
              }
              : item;
          }),
      async (item) => {
        if (!await security.check(userId, "view", item.id)) {
          return null;
        }
        if (item.kind === "imported") {
          const row = importedConcepts().find((entry) => entry.id === item.id);
          return row
            ? withoutFrontmatter(await store.get(row.objectKey))
            : null;
        }
        const row = concept(item.id);
        if (!row) return null;
        const canEdit = await security.check(
          userId,
          "edit",
          row.id,
        );
        if (
          row.status !== "active" || (!canEdit && !row.publishedRevision)
        ) return null;
        const doc = await payload(row, Boolean(canEdit), userId);
        return canEdit ? doc.draft : doc.published;
      },
      24_000,
      semanticIndex
        ? async (question) => {
          const visibleById = new Map(
            visible.documents.map((item) => [item.id, item]),
          );
          return await semanticIndex.search(question, ({ id, state }) => {
            const item = visibleById.get(id);
            if (!item || state !== searchState(item)) {
              return Promise.resolve(null);
            }
            const row = item.kind === "hub-native" ? concept(id) : null;
            return Promise.resolve({
              ...item,
              sourceLabel: row
                ? space(row.spaceId)?.name ?? row.spaceId
                : item.sourceLabel,
            });
          });
        }
        : undefined,
      () => searchTerms(respondWithAI, messages as AIMessage[]),
    );
    const message = await respondWithAI({
      messages: messages as {
        role: "user" | "assistant";
        content: string;
      }[],
      scope: "workspace",
      document: {
        title: "Workspace sources",
        space: "Workspace",
        state: "source",
        markdown: context,
      },
    });
    security.audit(userId, "ai.asked", "workspace");
    return { answer: message, citations };
  };
}

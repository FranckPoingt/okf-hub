import type { DatabaseSync } from "node:sqlite";

export type SearchState = "draft" | "published" | "source";
export type SearchFields = {
  title: string;
  type: string;
  tags: string[];
  body: string;
};

// The row a user may match: editors search active drafts, viewers and
// archived documents the publication.
export function searchState(
  item: {
    kind: string;
    canReviewConflicts?: boolean;
    status?: string;
    publishedRevision?: number | null;
  },
): SearchState {
  return item.kind === "imported" ? "source" : item.canReviewConflicts &&
      (item.status === "active" || !item.publishedRevision)
    ? "draft"
    : "published";
}

const quote = (term: string) => `"${term.replaceAll('"', '""')}"`;

/** SQLite FTS5 index ranked with BM25. It only scores (id, state) rows; callers
 * intersect them with the documents the user may see. Imports are mirrored by
 * SQL triggers; hub drafts and publications are written by the caller.
 */
export function createSearchIndex(db: DatabaseSync) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS okf_search_fts USING fts5(
      title, type, tags, body, id UNINDEXED, state UNINDEXED,
      tokenize = 'porter unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS okf_search_vocab
      USING fts5vocab(okf_search_fts, row);
    CREATE TRIGGER IF NOT EXISTS okf_search_concept_delete
    AFTER DELETE ON okf_concept BEGIN
      DELETE FROM okf_search_fts WHERE id = OLD.id AND state != 'source';
    END;
    CREATE TRIGGER IF NOT EXISTS okf_search_import_delete
    AFTER DELETE ON okf_imported_concept BEGIN
      DELETE FROM okf_search_fts WHERE id = OLD.id AND state = 'source';
    END;
  `);
  for (const event of ["INSERT", "UPDATE"]) {
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS okf_search_import_${event.toLowerCase()}
      AFTER ${event} ON okf_imported_concept BEGIN
        DELETE FROM okf_search_fts WHERE id = NEW.id AND state = 'source';
        INSERT INTO okf_search_fts (title, type, tags, body, id, state)
        SELECT NEW.title, NEW.type, NEW.tags, NEW.searchText, NEW.id, 'source'
        WHERE NEW.status = 'current';
      END;`,
    );
  }
  // Rebuild missing imports, e.g. a new table or a migrated okf_imported_concept.
  db.exec(`INSERT INTO okf_search_fts (title, type, tags, body, id, state)
    SELECT title, type, tags, searchText, id, 'source' FROM okf_imported_concept
    WHERE status = 'current' AND id NOT IN
      (SELECT id FROM okf_search_fts WHERE state = 'source')`);

  const remove = db.prepare(
    "DELETE FROM okf_search_fts WHERE id = ? AND state = ?",
  );
  const insert = db.prepare(
    "INSERT INTO okf_search_fts (title, type, tags, body, id, state) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const vocab = db.prepare(
    "SELECT term FROM okf_search_vocab WHERE term >= ? AND term < ? ORDER BY doc DESC LIMIT 16",
  );

  return {
    replace(id: string, state: SearchState, fields: SearchFields | null) {
      remove.run(id, state);
      if (fields) {
        insert.run(
          fields.title,
          fields.type,
          fields.tags.join(" "),
          fields.body,
          id,
          state,
        );
      }
    },
    has(id: string, state: SearchState) {
      return Boolean(
        db.prepare("SELECT 1 FROM okf_search_fts WHERE id = ? AND state = ?")
          .get(id, state),
      );
    },
    /** Every query word must match; returns BM25 relevance (higher is better) by `id\nstate`. */
    rank(query: string) {
      const groups: string[] = [];
      for (
        const word of new Set(
          query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [],
        )
      ) {
        // Porter also stems prefix queries ("pay"* is "pai"*), so word prefixes
        // and crude roots ("paying" -> "pay") expand through indexed terms.
        // shortcut: expanded terms are stemmed again by MATCH; porter is near-idempotent, so rare misses only lose recall.
        const roots = new Set(
          [word, word.replace(/(?:ing|ed|ments?|ers?|ions?|ies|es|s)$/, "")]
            .filter((root) => root.length >= 3),
        );
        const terms = new Set([`${quote(word)}*`]);
        for (const root of roots) {
          for (
            const { term } of vocab.all(root, `${root}\u{10FFFF}`) as {
              term: string;
            }[]
          ) terms.add(quote(term));
        }
        groups.push(`(${[...terms].join(" OR ")})`);
      }
      if (!groups.length) return new Map<string, number>();
      const rows = db.prepare(
        "SELECT id, state, bm25(okf_search_fts, 8, 3, 3, 1) AS rank FROM okf_search_fts WHERE okf_search_fts MATCH ?",
      ).all(groups.join(" AND ")) as {
        id: string;
        state: SearchState;
        rank: number;
      }[];
      return new Map(rows.map((row) => [`${row.id}\n${row.state}`, -row.rank]));
    },
  };
}

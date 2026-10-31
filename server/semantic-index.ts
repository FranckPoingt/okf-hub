import type { DatabaseSync } from "node:sqlite";
import type { Embedder } from "./ai.ts";
import type { RetrievalResult, SemanticMatch } from "./knowledge-retrieval.ts";

export type IndexedDocument = {
  id: string;
  state: "draft" | "published" | "source";
};
type Job = IndexedDocument & {
  version: string;
  attempts: number;
  contentHash: string | null;
  indexedModel: string | null;
};

// Prefer heading boundaries; split oversized sections at paragraphs or whitespace.
export function knowledgeChunks(markdown: string, max = 1_800): string[] {
  const chunks: string[] = [];
  let pending = "";
  for (let section of markdown.split(/(?=^#{1,6}\s)/m)) {
    if (pending && pending.length + section.length > max) {
      chunks.push(pending.trim());
      pending = "";
    }
    while (section.length > max) {
      const boundary = Math.max(
        section.lastIndexOf("\n\n", max),
        section.lastIndexOf("\n", max),
        section.lastIndexOf(" ", max),
      );
      const end = boundary >= max / 2 ? boundary : max;
      chunks.push(section.slice(0, end).trim());
      section = section.slice(end).trimStart();
    }
    pending += section;
  }
  if (pending.trim()) chunks.push(pending.trim());
  return chunks.filter(Boolean);
}

function validVector(vector: readonly number[]) {
  return vector.length > 0 && vector.every(Number.isFinite) &&
    vector.some((value) => value !== 0);
}

function cosine(a: readonly number[], b: readonly number[]) {
  if (a.length !== b.length || !validVector(b)) return -1;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] ** 2;
    bb += b[i] ** 2;
  }
  return dot / Math.sqrt(aa * bb);
}

async function hash(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Private SQLite index. SQL triggers invalidate changed content in the same transaction.
 * The durable queue doubles as the current-version manifest, including while stopped.
 */
export function createSemanticIndex(
  {
    db,
    embed,
    modelKey,
    load,
    intervalMs = 1_000,
    now = Date.now,
    log = (message) => console.warn(message),
  }: {
    db: DatabaseSync;
    embed: Embedder;
    modelKey: string;
    load: (
      document: IndexedDocument,
    ) => Promise<{ title: string; markdown: string } | null>;
    intervalMs?: number;
    now?: () => number;
    log?: (message: string) => void;
  },
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS okf_semantic_document (
      id TEXT NOT NULL, state TEXT NOT NULL, version TEXT NOT NULL,
      due INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      retryAt INTEGER NOT NULL DEFAULT 0, indexedVersion TEXT, indexedModel TEXT,
      contentHash TEXT, PRIMARY KEY (id, state)
    );
    CREATE TABLE IF NOT EXISTS okf_semantic_chunk (
      id TEXT NOT NULL, state TEXT NOT NULL, chunk INTEGER NOT NULL,
      contentHash TEXT NOT NULL, text TEXT NOT NULL, vector TEXT NOT NULL,
      PRIMARY KEY (id, state, chunk),
      FOREIGN KEY (id, state) REFERENCES okf_semantic_document(id, state) ON DELETE CASCADE
    );
  `);
  // Persist pending work at mutation time, including mutations made with embeddings off.
  for (const event of ["INSERT", "UPDATE"]) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS okf_semantic_hub_${event.toLowerCase()}
      AFTER ${event} ON okf_concept BEGIN
        INSERT INTO okf_semantic_document (id, state, version, due)
        VALUES (NEW.id, 'draft', hex(randomblob(16)), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 750)
        ON CONFLICT(id, state) DO UPDATE SET version = excluded.version, due = excluded.due, attempts = 0, retryAt = 0;
        INSERT INTO okf_semantic_document (id, state, version)
        SELECT NEW.id, 'published', CAST(NEW.publishedRevision AS TEXT) WHERE NEW.publishedRevision IS NOT NULL
        ON CONFLICT(id, state) DO UPDATE SET version = excluded.version, attempts = 0, retryAt = 0
        WHERE version != excluded.version;
        DELETE FROM okf_semantic_document WHERE id = NEW.id AND state = 'published' AND NEW.publishedRevision IS NULL;
      END;
      CREATE TRIGGER IF NOT EXISTS okf_semantic_import_${event.toLowerCase()}
      AFTER ${event} ON okf_imported_concept BEGIN
        INSERT INTO okf_semantic_document (id, state, version)
        SELECT NEW.id, 'source', NEW.contentHash WHERE NEW.status = 'current'
        ON CONFLICT(id, state) DO UPDATE SET version = excluded.version, attempts = 0, retryAt = 0
        WHERE version != excluded.version;
        DELETE FROM okf_semantic_document WHERE id = NEW.id AND NEW.status != 'current';
      END;
    `);
  }
  for (const table of ["okf_concept", "okf_imported_concept"]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS okf_semantic_${table}_delete
      AFTER DELETE ON ${table} BEGIN
        DELETE FROM okf_semantic_chunk WHERE id = OLD.id;
        DELETE FROM okf_semantic_document WHERE id = OLD.id;
      END;`);
  }
  // Metadata only: startup does not load documents or wait for the provider.
  db.exec(`
    INSERT OR IGNORE INTO okf_semantic_document (id, state, version)
      SELECT id, 'draft', hex(randomblob(16)) FROM okf_concept;
    INSERT OR IGNORE INTO okf_semantic_document (id, state, version)
      SELECT id, 'published', CAST(publishedRevision AS TEXT) FROM okf_concept WHERE publishedRevision IS NOT NULL;
    INSERT OR IGNORE INTO okf_semantic_document (id, state, version)
      SELECT id, 'source', contentHash FROM okf_imported_concept WHERE status = 'current';
  `);

  let stopped = false;
  let running: Promise<void> | undefined;
  const current = (job: Job) =>
    !stopped && Boolean(
      db.prepare(
        "SELECT 1 FROM okf_semantic_document WHERE id = ? AND state = ? AND version = ?",
      ).get(job.id, job.state, job.version),
    );

  async function index(job: Job) {
    try {
      const document = await load(job);
      if (!current(job)) return;
      if (!document) throw new Error("Index content unavailable");
      const contentHash = await hash(`${document.title}\n${document.markdown}`);
      if (job.contentHash !== contentHash || job.indexedModel !== modelKey) {
        const chunks = knowledgeChunks(document.markdown);
        const vectors: (readonly number[])[] = [];
        // Bound both concurrent documents (two) and provider batch size (eight).
        for (let i = 0; i < chunks.length; i += 8) {
          if (!current(job)) return;
          const batch = chunks.slice(i, i + 8);
          const result = await embed(
            batch.map((text) => `${document.title}\n${text}`),
          );
          if (
            result.length !== batch.length || !result.every(validVector) ||
            result.some((v) =>
              v.length !== (vectors[0]?.length ?? result[0]?.length)
            )
          ) {
            throw new Error("Invalid embeddings");
          }
          vectors.push(...result);
        }
        if (!current(job)) return;
        db.exec("BEGIN");
        try {
          db.prepare(
            "DELETE FROM okf_semantic_chunk WHERE id = ? AND state = ?",
          ).run(job.id, job.state);
          const insert = db.prepare(
            "INSERT INTO okf_semantic_chunk (id, state, chunk, contentHash, text, vector) VALUES (?, ?, ?, ?, ?, ?)",
          );
          chunks.forEach((text, i) =>
            insert.run(
              job.id,
              job.state,
              i,
              contentHash,
              text,
              JSON.stringify(vectors[i]),
            )
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      if (current(job)) {
        db.prepare(
          "UPDATE okf_semantic_document SET indexedVersion = version, indexedModel = ?, contentHash = ?, attempts = 0, retryAt = 0 WHERE id = ? AND state = ? AND version = ?",
        )
          .run(modelKey, contentHash, job.id, job.state, job.version);
      }
    } catch {
      if (!current(job)) return;
      // Provider exceptions may contain credentials or submitted content: never log them.
      log(
        `Semantic indexing failed for ${job.id} (${job.state}); retry scheduled`,
      );
      db.prepare(
        "UPDATE okf_semantic_document SET attempts = attempts + 1, retryAt = ? WHERE id = ? AND state = ? AND version = ?",
      )
        .run(
          now() + Math.min(300_000, 1_000 * 2 ** Math.min(job.attempts, 9)),
          job.id,
          job.state,
          job.version,
        );
    }
  }

  function refresh(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) return running;
    const jobs = db.prepare(`SELECT * FROM okf_semantic_document
      WHERE (indexedVersion IS NULL OR indexedVersion != version OR indexedModel != ?)
      AND due <= ? AND retryAt <= ? ORDER BY retryAt, due, id, state LIMIT 2`)
      .all(modelKey, now(), now()) as Job[];
    running = Promise.all(jobs.map(index)).then(() => {}).finally(() => {
      running = undefined;
    });
    return running;
  }
  const timer = intervalMs > 0
    ? setInterval(() => {
      void refresh();
    }, intervalMs)
    : undefined;

  return {
    refresh,
    async search(
      question: string,
      authorize: (document: IndexedDocument) => Promise<RetrievalResult | null>,
    ): Promise<SemanticMatch[]> {
      try {
        const [query] = await embed([question]);
        if (!query || !validVector(query) || stopped) return [];
        const docs = db.prepare(`SELECT id, state FROM okf_semantic_document
          WHERE indexedVersion = version AND indexedModel = ?`).all(
          modelKey,
        ) as IndexedDocument[];
        const ranked: (SemanticMatch & { score: number })[] = [];
        for (const doc of docs) {
          // Authorization and publication/draft selection precede vector access and ranking.
          const item = await authorize(doc);
          if (!item || stopped) continue;
          const chunks = db.prepare(
            "SELECT text, vector FROM okf_semantic_chunk WHERE id = ? AND state = ?",
          ).all(doc.id, doc.state) as { text: string; vector: string }[];
          let best: { excerpt: string; score: number } | undefined;
          // shortcut: brute-force cosine is sufficient for small workspaces; use an ANN index at scale.
          for (const chunk of chunks) {
            const score = cosine(query, JSON.parse(chunk.vector));
            if (score > 0 && (!best || score > best.score)) {
              best = { excerpt: chunk.text, score };
            }
          }
          if (best) ranked.push({ item, ...best });
        }
        return ranked.sort((a, b) =>
          b.score - a.score || a.item.title.localeCompare(b.item.title)
        ).slice(0, 24);
      } catch {
        log("Semantic query failed; using keyword retrieval");
        return [];
      }
    },
    async close() {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      await running;
    },
  };
}

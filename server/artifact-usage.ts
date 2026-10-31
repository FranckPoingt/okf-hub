/// <reference lib="deno.ns" />

import type { DatabaseSync } from "node:sqlite";

const DEBOUNCE_MS = 60 * 60 * 1000;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// The creator is whoever added the first App to the document.
const CREATOR =
  `(SELECT createdBy FROM okf_artifact WHERE conceptId = o.conceptId ORDER BY createdAt, id LIMIT 1)`;

// Self-hosted second-use metrics; reads only counts, never viewer identities.
export function createArtifactUsage(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS okf_artifact_open (
      conceptId TEXT NOT NULL,
      userId TEXT NOT NULL,
      openedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS okf_artifact_open_lookup
      ON okf_artifact_open (conceptId, userId, openedAt);
  `);
  const since = (now: Date) =>
    new Date(now.getTime() - WINDOW_MS).toISOString();
  const viewers = (conceptId: string, from: string) =>
    (db.prepare(
      `SELECT COUNT(DISTINCT userId) AS n FROM okf_artifact_open o
       WHERE conceptId = ? AND openedAt >= ? AND userId != COALESCE(${CREATOR}, '')`,
    ).get(conceptId, from) as { n: number }).n;

  return {
    /** Returns false when the user already opened this artifact within the hour. */
    record(conceptId: string, userId: string, now = new Date()) {
      const recent = db.prepare(
        "SELECT 1 FROM okf_artifact_open WHERE conceptId = ? AND userId = ? AND openedAt > ? LIMIT 1",
      ).get(
        conceptId,
        userId,
        new Date(now.getTime() - DEBOUNCE_MS).toISOString(),
      );
      if (recent) return false;
      db.prepare(
        "INSERT INTO okf_artifact_open (conceptId, userId, openedAt) VALUES (?, ?, ?)",
      ).run(conceptId, userId, now.toISOString());
      return true;
    },
    summary(conceptId: string, now = new Date()) {
      const creator = db.prepare(
        "SELECT createdBy FROM okf_artifact WHERE conceptId = ? ORDER BY createdAt, id LIMIT 1",
      ).get(conceptId) as { createdBy: string } | undefined;
      const others = creator?.createdBy ?? "";
      const count = (sql: string) =>
        (db.prepare(sql).get(conceptId, others) as { n: number }).n;
      return {
        viewers30d: viewers(conceptId, since(now)),
        viewersAllTime: viewers(conceptId, ""),
        othersSaves: count(
          `SELECT COUNT(*) AS n FROM okf_artifact_version v
           JOIN okf_artifact a ON a.id = v.artifactId
           WHERE a.conceptId = ? AND v.createdBy != ?`,
        ) +
          count(
            "SELECT COUNT(*) AS n FROM okf_revision WHERE conceptId = ? AND actorUserId != ?",
          ),
        lastOpenedAt: (db.prepare(
          "SELECT MAX(openedAt) AS at FROM okf_artifact_open WHERE conceptId = ?",
        ).get(conceptId) as { at: string | null }).at,
      };
    },
    /** Artifacts opened in the last 30 days by someone other than their creator. */
    reused(now = new Date()) {
      return (db.prepare(
        `SELECT conceptId, COUNT(DISTINCT userId) AS viewers FROM okf_artifact_open o
         WHERE openedAt >= ? AND userId != COALESCE(${CREATOR}, '')
         GROUP BY conceptId ORDER BY viewers DESC, MAX(openedAt) DESC`,
      ).all(since(now)) as { conceptId: string; viewers: number }[])
        .map(({ conceptId, viewers }) => ({ conceptId, viewers }));
    },
  };
}

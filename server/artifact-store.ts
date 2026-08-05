/// <reference lib="deno.ns" />

import { DatabaseSync } from "node:sqlite";

const MAX_ARTIFACT_BYTES = 128 * 1024;
const INLINE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

type ArtifactType = "inline_html" | "https_url";
type ArtifactRow = {
  id: string;
  conceptId: string;
  title: string;
  type: ArtifactType;
  draftVersion: number;
  liveVersion: number | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};
type VersionRow = {
  number: number;
  content: string;
  createdBy: string;
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
};

export class ArtifactInputError extends Error {}

function inlineDocument(content: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${INLINE_CSP}"><meta name="referrer" content="no-referrer"><style>html{color-scheme:light dark}body{margin:0;font-family:system-ui,sans-serif}</style></head><body>${content}</body></html>`;
}

function textBytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function createArtifactStore(
  db: DatabaseSync,
  configuredHosts: string[] = [],
) {
  const allowedHosts = Array.from(
    new Set(
      configuredHosts.map((host) => host.trim().toLocaleLowerCase()).filter(
        Boolean,
      ),
    ),
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS okf_artifact (
      id TEXT PRIMARY KEY,
      conceptId TEXT NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('inline_html', 'https_url')),
      draftVersion INTEGER NOT NULL,
      liveVersion INTEGER,
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS okf_artifact_version (
      artifactId TEXT NOT NULL,
      number INTEGER NOT NULL,
      content TEXT NOT NULL,
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      approvedBy TEXT,
      approvedAt TEXT,
      PRIMARY KEY (artifactId, number),
      FOREIGN KEY (artifactId) REFERENCES okf_artifact(id)
    );
  `);

  function validate(type: ArtifactType, content: string) {
    if (!content.trim()) {
      throw new ArtifactInputError("Artifact content is required");
    }
    if (textBytes(content) > MAX_ARTIFACT_BYTES) {
      throw new ArtifactInputError("Artifact content exceeds 128 KiB");
    }
    if (type === "inline_html") return content;
    let url: URL;
    try {
      url = new URL(content.trim());
    } catch {
      throw new ArtifactInputError("Enter a valid HTTPS artifact URL");
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new ArtifactInputError(
        "Artifact URLs must use HTTPS without credentials",
      );
    }
    if (!allowedHosts.includes(url.hostname.toLocaleLowerCase())) {
      throw new ArtifactInputError(
        `Artifact host is not allowed: ${url.hostname}`,
      );
    }
    return url.toString();
  }

  function artifact(id: string) {
    return db.prepare("SELECT * FROM okf_artifact WHERE id = ?").get(id) as
      | ArtifactRow
      | undefined;
  }

  function version(id: string, number: number) {
    return db.prepare(
      "SELECT number, content, createdBy, createdAt, approvedBy, approvedAt FROM okf_artifact_version WHERE artifactId = ? AND number = ?",
    ).get(id, number) as VersionRow | undefined;
  }

  function payload(item: ArtifactRow, canEdit: boolean) {
    const number = canEdit ? item.draftVersion : item.liveVersion;
    if (!number) return null;
    const selected = version(item.id, number)!;
    const versions = canEdit
      ? db.prepare(
        "SELECT number, createdBy, createdAt, approvedBy, approvedAt FROM okf_artifact_version WHERE artifactId = ? ORDER BY number DESC",
      ).all(item.id)
      : [];
    return {
      id: item.id,
      conceptId: item.conceptId,
      title: item.title,
      type: item.type,
      status: item.liveVersion
        ? item.draftVersion > item.liveVersion ? "changes_pending" : "live"
        : "draft",
      draftVersion: canEdit ? item.draftVersion : undefined,
      liveVersion: item.liveVersion,
      version: number,
      content: canEdit ? selected.content : undefined,
      document: item.type === "inline_html"
        ? inlineDocument(selected.content)
        : undefined,
      url: item.type === "https_url" ? selected.content : undefined,
      versions,
      updatedAt: item.updatedAt,
    };
  }

  return {
    allowedHosts,
    list(conceptId: string, canEdit: boolean) {
      return (db.prepare(
        `SELECT * FROM okf_artifact WHERE conceptId = ? ${
          canEdit ? "" : "AND liveVersion IS NOT NULL"
        } ORDER BY updatedAt DESC`,
      ).all(conceptId) as ArtifactRow[]).map((item) => payload(item, canEdit));
    },
    create(input: {
      conceptId: string;
      title: string;
      type: ArtifactType;
      content: string;
      actorUserId: string;
    }) {
      const title = input.title.trim();
      if (!title || title.length > 100) {
        throw new ArtifactInputError("Artifact title must be 1–100 characters");
      }
      if (!(["inline_html", "https_url"] as string[]).includes(input.type)) {
        throw new ArtifactInputError("Choose an artifact type");
      }
      const content = validate(input.type, input.content);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.exec("BEGIN");
      try {
        db.prepare(
          "INSERT INTO okf_artifact (id, conceptId, title, type, draftVersion, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
        ).run(
          id,
          input.conceptId,
          title,
          input.type,
          input.actorUserId,
          now,
          now,
        );
        db.prepare(
          "INSERT INTO okf_artifact_version (artifactId, number, content, createdBy, createdAt) VALUES (?, 1, ?, ?, ?)",
        ).run(id, content, input.actorUserId, now);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return payload(artifact(id)!, true);
    },
    revise(id: string, content: string, actorUserId: string) {
      const item = artifact(id);
      if (!item) return null;
      const next = item.draftVersion + 1;
      const validated = validate(item.type, content);
      const now = new Date().toISOString();
      db.exec("BEGIN");
      try {
        db.prepare(
          "INSERT INTO okf_artifact_version (artifactId, number, content, createdBy, createdAt) VALUES (?, ?, ?, ?, ?)",
        ).run(id, next, validated, actorUserId, now);
        db.prepare(
          "UPDATE okf_artifact SET draftVersion = ?, updatedAt = ? WHERE id = ?",
        ).run(next, now, id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return payload(artifact(id)!, true);
    },
    publish(id: string, actorUserId: string) {
      const item = artifact(id);
      if (!item) return null;
      const now = new Date().toISOString();
      db.exec("BEGIN");
      try {
        db.prepare(
          "UPDATE okf_artifact_version SET approvedBy = ?, approvedAt = ? WHERE artifactId = ? AND number = ?",
        ).run(actorUserId, now, id, item.draftVersion);
        db.prepare(
          "UPDATE okf_artifact SET liveVersion = draftVersion, updatedAt = ? WHERE id = ?",
        ).run(now, id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return payload(artifact(id)!, true);
    },
    conceptId(id: string) {
      return artifact(id)?.conceptId;
    },
  };
}

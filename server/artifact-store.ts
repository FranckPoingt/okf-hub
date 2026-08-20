/// <reference lib="deno.ns" />

import { DatabaseSync } from "node:sqlite";

// ponytail: SQLite-backed bundles cap at 8 MiB; move assets to object storage
// when real app bundles regularly approach this ceiling.
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_FILES = 200;
const MAX_APP_DATA_BYTES = 16 * 1024;
const BUNDLE_PREFIX = "okf-bundle-v1:";
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
  description: string;
  grants: string;
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
type BundleFile = { path: string; type: string; data: string };
type AppBundle = { entry: string; files: BundleFile[] };

export class ArtifactInputError extends Error {}

function inlineDocument(content: string) {
  const bridge =
    `<script>(()=>{const pending=new Map();addEventListener("message",event=>{const message=event.data;if(message?.type!=="okf:result")return;const request=pending.get(message.id);if(!request)return;pending.delete(message.id);message.error?request.reject(new Error(message.error)):request.resolve(message.result)});function action(name,input={}){return new Promise((resolve,reject)=>{const id=crypto.randomUUID();pending.set(id,{resolve,reject});parent.postMessage({type:"okf:action",id,name,input},"*")})}window.okf={action,data:{list:(collection)=>action("app.data.list",{collection}),get:(collection,key)=>action("app.data.get",{collection,key}),set:(collection,key,value)=>action("app.data.set",{collection,key,value}),remove:(collection,key)=>action("app.data.remove",{collection,key})}}})();</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${INLINE_CSP}"><meta name="referrer" content="no-referrer"><style>html{color-scheme:light dark}body{margin:0;font-family:system-ui,sans-serif}</style></head><body>${bridge}${content}</body></html>`;
}

function safeBundlePath(value: string) {
  const path = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !path || path.startsWith("/") || path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new ArtifactInputError("App bundle contains an unsafe file path");
  return path;
}

function parseBundle(content: string): AppBundle | null {
  if (!content.startsWith(BUNDLE_PREFIX)) return null;
  let input: unknown;
  try {
    input = JSON.parse(content.slice(BUNDLE_PREFIX.length));
  } catch {
    throw new ArtifactInputError("App bundle is not valid JSON");
  }
  if (!input || typeof input !== "object") {
    throw new ArtifactInputError("App bundle is invalid");
  }
  const candidate = input as { entry?: unknown; files?: unknown };
  if (!Array.isArray(candidate.files) || !candidate.files.length) {
    throw new ArtifactInputError("App bundle must contain files");
  }
  if (candidate.files.length > MAX_BUNDLE_FILES) {
    throw new ArtifactInputError(
      `App bundle exceeds ${MAX_BUNDLE_FILES} files`,
    );
  }
  const files = candidate.files.map((item) => {
    if (!item || typeof item !== "object") {
      throw new ArtifactInputError("App bundle contains an invalid file");
    }
    const file = item as Record<string, unknown>;
    const path = safeBundlePath(String(file.path ?? ""));
    const type = String(file.type ?? "application/octet-stream").slice(0, 120);
    const data = String(file.data ?? "");
    if (!/^data:[^,;]+;base64,[A-Za-z0-9+/=]*$/.test(data)) {
      throw new ArtifactInputError(`App bundle file is invalid: ${path}`);
    }
    return { path, type, data };
  });
  const unique = new Set(files.map((file) => file.path));
  if (unique.size !== files.length) {
    throw new ArtifactInputError("App bundle contains duplicate file paths");
  }
  const entry = safeBundlePath(String(candidate.entry ?? "index.html"));
  if (!unique.has(entry) || !entry.toLowerCase().endsWith(".html")) {
    throw new ArtifactInputError("App bundle needs an index.html entry file");
  }
  return { entry, files };
}

function bundleBytes(file: BundleFile) {
  const encoded = file.data.slice(file.data.indexOf(",") + 1);
  try {
    return Uint8Array.from(
      atob(encoded),
      (character) => character.charCodeAt(0),
    );
  } catch {
    throw new ArtifactInputError(`App bundle file is invalid: ${file.path}`);
  }
}

function bundleDocument(source: string) {
  const bridge =
    `<script>(()=>{const pending=new Map();addEventListener("message",event=>{const message=event.data;if(message?.type!=="okf:result")return;const request=pending.get(message.id);if(!request)return;pending.delete(message.id);message.error?request.reject(new Error(message.error)):request.resolve(message.result)});function action(name,input={}){return new Promise((resolve,reject)=>{const id=crypto.randomUUID();pending.set(id,{resolve,reject});parent.postMessage({type:"okf:action",id,name,input},"*")})}window.okf={action,data:{list:(collection)=>action("app.data.list",{collection}),get:(collection,key)=>action("app.data.get",{collection,key}),set:(collection,key,value)=>action("app.data.set",{collection,key,value}),remove:(collection,key)=>action("app.data.remove",{collection,key})}}})();</script>`;
  const security =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'"><meta name="referrer" content="no-referrer">${bridge}`;
  return /<head(?:\s[^>]*)?>/i.test(source)
    ? source.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${security}`)
    : `${security}${source}`;
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
      description TEXT NOT NULL DEFAULT '',
      grants TEXT NOT NULL DEFAULT '[]',
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
    CREATE TABLE IF NOT EXISTS okf_artifact_data (
      artifactId TEXT NOT NULL,
      userId TEXT NOT NULL,
      collection TEXT NOT NULL,
      itemKey TEXT NOT NULL,
      value TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (artifactId, userId, collection, itemKey),
      FOREIGN KEY (artifactId) REFERENCES okf_artifact(id)
    );
  `);
  const artifactColumns = new Set(
    (db.prepare("PRAGMA table_info(okf_artifact)").all() as { name: string }[])
      .map(({ name }) => name),
  );
  if (!artifactColumns.has("description")) {
    db.exec(
      "ALTER TABLE okf_artifact ADD COLUMN description TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!artifactColumns.has("grants")) {
    db.exec(
      "ALTER TABLE okf_artifact ADD COLUMN grants TEXT NOT NULL DEFAULT '[]'",
    );
  }

  function validateGrants(grants: string[]) {
    const clean = Array.from(new Set(grants.map((grant) => grant.trim())))
      .filter(Boolean);
    if (
      clean.length > 20 ||
      clean.some((grant) => !/^[a-z][a-z0-9-]*(?:\.[a-z0-9*-]+)+$/.test(grant))
    ) {
      throw new ArtifactInputError("Choose valid app capabilities");
    }
    return clean;
  }

  function dataName(value: string, label: string) {
    const clean = value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(clean)) {
      throw new ArtifactInputError(`${label} must be 1–80 safe characters`);
    }
    return clean;
  }

  function validate(type: ArtifactType, content: string) {
    if (!content.trim()) {
      throw new ArtifactInputError("Artifact content is required");
    }
    if (textBytes(content) > MAX_ARTIFACT_BYTES) {
      throw new ArtifactInputError("App bundle exceeds 8 MiB");
    }
    if (type === "inline_html") {
      parseBundle(content);
      return content;
    }
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
    const bundle = item.type === "inline_html"
      ? parseBundle(selected.content)
      : null;
    return {
      id: item.id,
      conceptId: item.conceptId,
      title: item.title,
      description: item.description,
      grants: JSON.parse(item.grants) as string[],
      type: item.type,
      status: item.liveVersion
        ? item.draftVersion > item.liveVersion ? "changes_pending" : "live"
        : "draft",
      draftVersion: canEdit ? item.draftVersion : undefined,
      liveVersion: item.liveVersion,
      version: number,
      content: canEdit ? selected.content : undefined,
      bundle: bundle
        ? { entry: bundle.entry, files: bundle.files.map((file) => file.path) }
        : undefined,
      document: item.type === "inline_html" && !bundle
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
    exportFiles(conceptId: string) {
      return (db.prepare(
        "SELECT * FROM okf_artifact WHERE conceptId = ? ORDER BY createdAt",
      ).all(conceptId) as ArtifactRow[]).map((item) => {
        const selected = version(item.id, item.draftVersion)!;
        const bundle = item.type === "inline_html"
          ? parseBundle(selected.content)
          : null;
        return {
          id: item.id,
          title: item.title,
          files: bundle
            ? bundle.files.map((file) => ({
              path: file.path,
              body: bundleBytes(file),
            }))
            : [{
              path: item.type === "inline_html" ? "index.html" : "url.txt",
              body: item.type === "inline_html"
                ? selected.content
                : `${selected.content.trim()}\n`,
            }],
        };
      });
    },
    create(input: {
      conceptId: string;
      title: string;
      description?: string;
      grants?: string[];
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
      const description = input.description?.trim().slice(0, 240) ?? "";
      const grants = validateGrants(input.grants ?? ["app.data.*"]);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.exec("BEGIN");
      try {
        db.prepare(
          "INSERT INTO okf_artifact (id, conceptId, title, description, grants, type, draftVersion, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
        ).run(
          id,
          input.conceptId,
          title,
          description,
          JSON.stringify(grants),
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
    revise(
      id: string,
      content: string,
      actorUserId: string,
      metadata: { description?: string; grants?: string[] } = {},
    ) {
      const item = artifact(id);
      if (!item) return null;
      const next = item.draftVersion + 1;
      const validated = validate(item.type, content);
      const description = metadata.description === undefined
        ? item.description
        : metadata.description.trim().slice(0, 240);
      const grants = metadata.grants === undefined
        ? JSON.parse(item.grants) as string[]
        : validateGrants(metadata.grants);
      const now = new Date().toISOString();
      db.exec("BEGIN");
      try {
        db.prepare(
          "INSERT INTO okf_artifact_version (artifactId, number, content, createdBy, createdAt) VALUES (?, ?, ?, ?, ?)",
        ).run(id, next, validated, actorUserId, now);
        db.prepare(
          "UPDATE okf_artifact SET draftVersion = ?, description = ?, grants = ?, updatedAt = ? WHERE id = ?",
        ).run(next, description, JSON.stringify(grants), now, id);
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
    grants(id: string) {
      const item = artifact(id);
      return item ? JSON.parse(item.grants) as string[] : null;
    },
    file(id: string, requestedPath: string, canEdit: boolean) {
      const item = artifact(id);
      const number = item && (canEdit ? item.draftVersion : item.liveVersion);
      if (!item || !number) return null;
      const selected = version(id, number);
      const bundle = selected ? parseBundle(selected.content) : null;
      if (!bundle) return null;
      const path = requestedPath ? safeBundlePath(requestedPath) : bundle.entry;
      const file = bundle.files.find((candidate) => candidate.path === path);
      if (!file) return null;
      const bytes = bundleBytes(file);
      if (path === bundle.entry) {
        return {
          body: new TextEncoder().encode(
            bundleDocument(new TextDecoder().decode(bytes)),
          ),
          type: "text/html; charset=utf-8",
        };
      }
      return { body: bytes, type: file.type || "application/octet-stream" };
    },
    data: {
      list(id: string, userId: string, collection: string) {
        const cleanCollection = dataName(collection, "Collection");
        return db.prepare(
          "SELECT itemKey AS key, value, updatedAt FROM okf_artifact_data WHERE artifactId = ? AND userId = ? AND collection = ? ORDER BY itemKey",
        ).all(id, userId, cleanCollection).map((row) => ({
          key: String((row as { key: string }).key),
          value: JSON.parse(String((row as { value: string }).value)),
          updatedAt: String((row as { updatedAt: string }).updatedAt),
        }));
      },
      get(id: string, userId: string, collection: string, key: string) {
        const row = db.prepare(
          "SELECT value, updatedAt FROM okf_artifact_data WHERE artifactId = ? AND userId = ? AND collection = ? AND itemKey = ?",
        ).get(
          id,
          userId,
          dataName(collection, "Collection"),
          dataName(key, "Key"),
        ) as { value: string; updatedAt: string } | undefined;
        return row
          ? { value: JSON.parse(row.value), updatedAt: row.updatedAt }
          : null;
      },
      set(
        id: string,
        userId: string,
        collection: string,
        key: string,
        value: unknown,
      ) {
        const encoded = JSON.stringify(value);
        if (encoded === undefined || textBytes(encoded) > MAX_APP_DATA_BYTES) {
          throw new ArtifactInputError("App data exceeds 16 KiB");
        }
        const now = new Date().toISOString();
        db.prepare(
          "INSERT INTO okf_artifact_data (artifactId, userId, collection, itemKey, value, updatedAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(artifactId, userId, collection, itemKey) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt",
        ).run(
          id,
          userId,
          dataName(collection, "Collection"),
          dataName(key, "Key"),
          encoded,
          now,
        );
        return { value, updatedAt: now };
      },
      remove(id: string, userId: string, collection: string, key: string) {
        db.prepare(
          "DELETE FROM okf_artifact_data WHERE artifactId = ? AND userId = ? AND collection = ? AND itemKey = ?",
        ).run(
          id,
          userId,
          dataName(collection, "Collection"),
          dataName(key, "Key"),
        );
        return { removed: true };
      },
    },
  };
}

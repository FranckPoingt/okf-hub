/// <reference lib="deno.ns" />

import * as Y from "yjs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, normalize } from "node:path/posix";
import { createCredentialVault } from "./credential-vault.ts";
import { createObjectStore } from "./object-store.ts";
import {
  inspectOkf,
  type RepositorySnapshot,
  syncRepository,
} from "./repository-source.ts";
import { CONCEPT, createSecurity } from "./security.ts";
import { type SharedSourceConfig, syncSharedSource } from "./shared-source.ts";

const DOCUMENT_UPDATE = 0;
const AWARENESS_UPDATE = 1;
const MAX_MARKDOWN_BYTES = 512 * 1024;

class MarkdownTooLarge extends Error {}

export const DEFAULT_MARKDOWN = `# Incident communication

How Acme keeps customers and internal teams informed during a service incident.

> Clear, regular updates matter more than perfect information.

## Before an incident

- [x] Assign an incident lead
- [ ] Confirm the customer update channel
- Link the [technical response guide](https://example.com/incident-response)

## During an incident

| Severity | Update cadence | Owner |
| --- | --- | --- |
| SEV-1 | Every 30 minutes | Incident communicator |
| SEV-2 | Every 60 minutes | Service owner |

Do not wait for a complete diagnosis. ~~Silence avoids confusion.~~ A short factual update builds trust.[^owner]

The availability target is $SLO = 99.9\\%$.

$$
budget = 1 - SLO
$$

\`\`\`mermaid
flowchart LR
  Detect --> Assign --> Update --> Resolve
\`\`\`

[^owner]: The incident lead remains accountable for approving external updates.
`;

type AppOptions = {
  dataDir?: string;
  staticDir?: string;
  baseURL?: string;
  authSecret?: string;
  openfgaURL?: string;
  openfgaKey?: string;
  s3Endpoint?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  s3Bucket?: string;
  objectStore?: {
    put(key: string, markdown: string): Promise<void>;
    get(key: string): Promise<string>;
  };
  repositorySync?: (
    checkout: string,
    repositoryUrl: string,
    folder: string,
  ) => Promise<RepositorySnapshot>;
  sharedSourceSync?: (
    config: SharedSourceConfig,
  ) => Promise<RepositorySnapshot>;
};

type ConceptRow = {
  id: string;
  title: string;
  type: string;
  status: "active" | "archived";
  publishedRevision: number | null;
  updatedAt: string;
};

type RevisionRow = {
  number: number;
  objectKey: string;
  publishedAt: string;
  actorUserId: string;
};

type RepositorySourceRow = {
  repositoryUrl: string;
  folder: string;
  status: "syncing" | "current" | "sync_failed";
  revision: string | null;
  lastSyncedAt: string | null;
  error: string | null;
};

type SharedSourceRow = {
  endpoint: string;
  bucket: string;
  path: string;
  region: string;
  credentialsCipher: string;
  status: "syncing" | "current" | "sync_failed";
  revision: string | null;
  lastSyncedAt: string | null;
  error: string | null;
};

type ImportedConceptRow = {
  id: string;
  sourceId: "repository" | "shared";
  path: string;
  title: string;
  type: string;
  status: "current" | "invalid" | "deleted" | "renamed";
  objectKey: string;
  sourceRevision: string;
  contentHash: string;
  importedAt: string;
  nextPath: string | null;
  tags: string;
  owner: string;
  links: string;
  searchText: string;
};

type SearchDocument = {
  id: string;
  kind: "hub-native" | "imported";
  sourceId: "hub" | "repository" | "shared";
  sourceLabel: string;
  sourceStatus: "current" | "sync_failed";
  title: string;
  type: string;
  tags: string[];
  owner: string;
  status: "active" | "archived" | "current";
  trust: "current" | "sync_failed";
  searchText: string;
  path?: string;
  sourceRevision?: string;
  importedAt?: string;
  linkHrefs: string[];
};

function bodyOnly(markdown: string) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?/);
  return match?.[1].match(/^type\s*:/m)
    ? markdown.slice(match[0].length)
    : markdown;
}

function withoutFrontmatter(markdown: string) {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)?/);
  return match ? markdown.slice(match[0].length) : markdown;
}

function searchSnippet(text: string, query: string) {
  const plain = text.replace(/[`*_>#|[\]()~-]/g, " ").replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  const firstTerm = query.toLocaleLowerCase().split(/\s+/).find(Boolean);
  const match = firstTerm ? plain.toLocaleLowerCase().indexOf(firstTerm) : -1;
  const start = Math.max(0, match < 0 ? 0 : match - 55);
  const prefix = start ? "…" : "";
  const excerpt = plain.slice(start, start + 180);
  return `${prefix}${excerpt}${
    start + excerpt.length < plain.length ? "…" : ""
  }`;
}

export function publishedMarkdown(
  body: string,
  actorUserId: string,
  publishedAt: string,
) {
  return `---\ntype: Policy\ntitle: "Incident communication"\nstatus: stable\ngenerated: { by: "human:${actorUserId}", at: "${publishedAt}" }\n---\n\n${
    bodyOnly(body).trimEnd()
  }\n`;
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function frame(type: number, payload: Uint8Array) {
  const result = new Uint8Array(payload.length + 1);
  result[0] = type;
  result.set(payload, 1);
  return result;
}

function allowedOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin ||
    ["http://localhost:3000", "http://127.0.0.1:3000"].includes(origin);
}

function cors(request: Request) {
  return {
    "access-control-allow-origin": request.headers.get("origin") ?? "*",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-credentials": "true",
  };
}

function withCors(response: Response, request: Request) {
  const headers = new Headers(response.headers);
  Object.entries(cors(request)).forEach(([name, value]) =>
    headers.set(name, value)
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function bytes(data: unknown): Promise<Uint8Array | null> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return null;
}

function extension(path: string) {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(index);
}

export async function createCollabApp({
  dataDir = ".okf-data",
  staticDir = "dist",
  baseURL,
  authSecret,
  openfgaURL,
  openfgaKey,
  s3Endpoint,
  s3AccessKey,
  s3SecretKey,
  s3Bucket = "okf-hub",
  objectStore,
  repositorySync = syncRepository,
  sharedSourceSync = syncSharedSource,
}: AppOptions = {}) {
  await Deno.mkdir(dataDir, { recursive: true });
  const security = await createSecurity({
    dataDir,
    baseURL,
    authSecret,
    openfgaURL,
    openfgaKey,
  });
  const markdownPath = `${dataDir}/incident-communication.md`;
  const statePath = `${dataDir}/incident-communication.yjs`;
  const doc = new Y.Doc();
  const clients = new Set<WebSocket>();
  const db = new DatabaseSync(`${dataDir}/hub.db`);
  const credentialVault = await createCredentialVault(dataDir);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS okf_concept (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      publishedRevision INTEGER,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS okf_revision (
      conceptId TEXT NOT NULL,
      number INTEGER NOT NULL,
      objectKey TEXT NOT NULL,
      publishedAt TEXT NOT NULL,
      actorUserId TEXT NOT NULL,
      PRIMARY KEY (conceptId, number),
      FOREIGN KEY (conceptId) REFERENCES okf_concept(id)
    );
    CREATE TABLE IF NOT EXISTS okf_repository_source (
      id TEXT PRIMARY KEY CHECK (id = 'repository'),
      repositoryUrl TEXT NOT NULL,
      folder TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('syncing', 'current', 'sync_failed')),
      revision TEXT,
      lastSyncedAt TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS okf_shared_source (
      id TEXT PRIMARY KEY CHECK (id = 'shared'),
      endpoint TEXT NOT NULL,
      bucket TEXT NOT NULL,
      path TEXT NOT NULL,
      region TEXT NOT NULL,
      credentialsCipher TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('syncing', 'current', 'sync_failed')),
      revision TEXT,
      lastSyncedAt TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS okf_imported_concept (
      id TEXT PRIMARY KEY,
      sourceId TEXT NOT NULL CHECK (sourceId IN ('repository', 'shared')),
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('current', 'invalid', 'deleted', 'renamed')),
      objectKey TEXT NOT NULL,
      sourceRevision TEXT NOT NULL,
      contentHash TEXT NOT NULL,
      importedAt TEXT NOT NULL,
      nextPath TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      owner TEXT NOT NULL DEFAULT '',
      links TEXT NOT NULL DEFAULT '[]',
      searchText TEXT NOT NULL DEFAULT '',
      UNIQUE (sourceId, path)
    );
    CREATE TABLE IF NOT EXISTS okf_imported_revision (
      conceptId TEXT NOT NULL,
      sourceRevision TEXT NOT NULL,
      objectKey TEXT NOT NULL,
      importedAt TEXT NOT NULL,
      PRIMARY KEY (conceptId, sourceRevision)
    );
    CREATE TABLE IF NOT EXISTS okf_import_issue (
      sourceId TEXT NOT NULL CHECK (sourceId IN ('repository', 'shared')),
      path TEXT NOT NULL,
      error TEXT NOT NULL,
      PRIMARY KEY (sourceId, path)
    );
  `);
  const importedColumns = db.prepare("PRAGMA table_info(okf_imported_concept)")
    .all() as { name: string }[];
  if (!importedColumns.some(({ name }) => name === "sourceId")) {
    db.exec(`
      BEGIN;
      ALTER TABLE okf_imported_concept RENAME TO okf_imported_concept_legacy;
      CREATE TABLE okf_imported_concept (
        id TEXT PRIMARY KEY,
        sourceId TEXT NOT NULL CHECK (sourceId IN ('repository', 'shared')),
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('current', 'invalid', 'deleted', 'renamed')),
        objectKey TEXT NOT NULL,
        sourceRevision TEXT NOT NULL,
        contentHash TEXT NOT NULL,
        importedAt TEXT NOT NULL,
        nextPath TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        owner TEXT NOT NULL DEFAULT '',
        links TEXT NOT NULL DEFAULT '[]',
        searchText TEXT NOT NULL DEFAULT '',
        UNIQUE (sourceId, path)
      );
      INSERT INTO okf_imported_concept
        (id, sourceId, path, title, type, status, objectKey, sourceRevision, contentHash, importedAt, nextPath, tags, owner, links, searchText)
        SELECT id, 'repository', path, title, type, status, objectKey, sourceRevision, contentHash, importedAt, nextPath, '[]', '', '[]', lower(title || ' ' || type)
        FROM okf_imported_concept_legacy;
      DROP TABLE okf_imported_concept_legacy;
      ALTER TABLE okf_import_issue RENAME TO okf_import_issue_legacy;
      CREATE TABLE okf_import_issue (
        sourceId TEXT NOT NULL CHECK (sourceId IN ('repository', 'shared')),
        path TEXT NOT NULL,
        error TEXT NOT NULL,
        PRIMARY KEY (sourceId, path)
      );
      INSERT INTO okf_import_issue (sourceId, path, error)
        SELECT 'repository', path, error FROM okf_import_issue_legacy;
      DROP TABLE okf_import_issue_legacy;
      COMMIT;
    `);
  }
  const searchableColumns = new Set(
    (db.prepare("PRAGMA table_info(okf_imported_concept)").all() as {
      name: string;
    }[]).map(({ name }) => name),
  );
  for (
    const [name, definition] of [
      ["tags", "TEXT NOT NULL DEFAULT '[]'"],
      ["owner", "TEXT NOT NULL DEFAULT ''"],
      ["links", "TEXT NOT NULL DEFAULT '[]'"],
      ["searchText", "TEXT NOT NULL DEFAULT ''"],
    ]
  ) {
    if (!searchableColumns.has(name)) {
      db.exec(
        `ALTER TABLE okf_imported_concept ADD COLUMN ${name} ${definition}`,
      );
    }
  }
  const store = objectStore ??
    (s3Endpoint && s3AccessKey && s3SecretKey
      ? createObjectStore({
        endpoint: s3Endpoint,
        accessKey: s3AccessKey,
        secretKey: s3SecretKey,
        bucket: s3Bucket,
      })
      : {
        put: () =>
          Promise.reject(new Error("Object storage is not configured")),
        get: () =>
          Promise.reject(new Error("Object storage is not configured")),
      });

  const concept = () =>
    db.prepare("SELECT * FROM okf_concept WHERE id = ?").get(CONCEPT) as
      | ConceptRow
      | undefined;
  const revisions = () =>
    db.prepare(
      "SELECT number, objectKey, publishedAt, actorUserId FROM okf_revision WHERE conceptId = ? ORDER BY number DESC",
    ).all(CONCEPT) as RevisionRow[];
  const repositorySource = () =>
    db.prepare("SELECT * FROM okf_repository_source WHERE id = 'repository'")
      .get() as RepositorySourceRow | undefined;
  const sharedSource = () =>
    db.prepare("SELECT * FROM okf_shared_source WHERE id = 'shared'").get() as
      | SharedSourceRow
      | undefined;
  const importedConcepts = (
    sourceId?: "repository" | "shared",
    statuses = ["current"],
  ) =>
    db.prepare(
      "SELECT * FROM okf_imported_concept WHERE " +
        (sourceId ? "sourceId = ? AND " : "") + "status IN (" +
        statuses.map(() => "?").join(",") + ") ORDER BY title, path",
    ).all(
      ...(sourceId ? [sourceId, ...statuses] : statuses),
    ) as ImportedConceptRow[];
  const importedId = (sourceId: string, path: string) =>
    sourceId + "/" + encodeURIComponent(path.replace(/\.md$/i, ""));
  const importedObjectKey = (
    sourceId: string,
    revision: string,
    path: string,
  ) =>
    `sources/${sourceId}/` + revision + "/" +
    path.split("/").map(encodeURIComponent).join("/");
  const importedPayload = (item: ImportedConceptRow) => ({
    id: item.id,
    sourceId: item.sourceId,
    path: item.path,
    title: item.title,
    type: item.type,
    status: item.status,
    sourceRevision: item.sourceRevision,
    importedAt: item.importedAt,
    tags: JSON.parse(item.tags) as string[],
    owner: item.owner,
  });

  function sourcePayload(sourceId: "repository" | "shared") {
    const source = sourceId === "repository"
      ? repositorySource()
      : sharedSource();
    if (!source) return null;
    const issues = db.prepare(
      "SELECT path, 'invalid' AS status, error, NULL AS nextPath FROM okf_import_issue WHERE sourceId = ? UNION ALL SELECT path, status, NULL AS error, nextPath FROM okf_imported_concept WHERE sourceId = ? AND status IN ('deleted', 'renamed') ORDER BY path",
    ).all(sourceId, sourceId);
    const common = {
      id: sourceId,
      status: source.status,
      revision: source.revision,
      lastSyncedAt: source.lastSyncedAt,
      error: source.error,
      conceptCount: importedConcepts(sourceId).length,
      issues,
    };
    return sourceId === "repository"
      ? {
        ...common,
        kind: "git",
        repositoryUrl: (source as RepositorySourceRow).repositoryUrl,
        folder: (source as RepositorySourceRow).folder,
      }
      : {
        ...common,
        kind: "s3",
        endpoint: (source as SharedSourceRow).endpoint,
        bucket: (source as SharedSourceRow).bucket,
        path: (source as SharedSourceRow).path,
        region: (source as SharedSourceRow).region,
        credentialsConfigured: true,
      };
  }

  async function importSnapshot(
    sourceId: "repository" | "shared",
    snapshot: RepositorySnapshot,
    markCurrent: (revision: string, now: string) => void,
  ) {
    for (const file of snapshot.files) {
      await store.put(
        importedObjectKey(sourceId, snapshot.revision, file.path),
        file.markdown,
      );
      await security.ensureImportedConcept(importedId(sourceId, file.path));
    }

    const previous = importedConcepts(sourceId, ["current", "invalid"]);
    const previousPaths = new Set(previous.map((item) => item.path));
    const observedPaths = new Set([
      ...snapshot.files.map((file) => file.path),
      ...snapshot.issues.map((issue) => issue.path),
    ]);
    const newFiles = snapshot.files.filter((file) =>
      !previousPaths.has(file.path)
    );
    const now = new Date().toISOString();
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM okf_import_issue WHERE sourceId = ?").run(
        sourceId,
      );
      for (const issue of snapshot.issues) {
        db.prepare(
          "INSERT INTO okf_import_issue (sourceId, path, error) VALUES (?, ?, ?)",
        ).run(sourceId, issue.path, issue.error);
        db.prepare(
          "UPDATE okf_imported_concept SET status = 'invalid', nextPath = NULL WHERE sourceId = ? AND path = ?",
        ).run(sourceId, issue.path);
      }
      for (const item of previous) {
        if (observedPaths.has(item.path)) continue;
        const renamed = newFiles.find((file) => file.hash === item.contentHash);
        db.prepare(
          "UPDATE okf_imported_concept SET status = ?, nextPath = ? WHERE id = ?",
        ).run(renamed ? "renamed" : "deleted", renamed?.path ?? null, item.id);
      }
      for (const file of snapshot.files) {
        const id = importedId(sourceId, file.path);
        const key = importedObjectKey(sourceId, snapshot.revision, file.path);
        db.prepare(
          "INSERT INTO okf_imported_concept " +
            "(id, sourceId, path, title, type, status, objectKey, sourceRevision, contentHash, importedAt, nextPath, tags, owner, links, searchText) " +
            "VALUES (?, ?, ?, ?, ?, 'current', ?, ?, ?, ?, NULL, ?, ?, ?, ?) " +
            "ON CONFLICT(sourceId, path) DO UPDATE SET " +
            "title = excluded.title, type = excluded.type, status = 'current', " +
            "objectKey = excluded.objectKey, sourceRevision = excluded.sourceRevision, " +
            "contentHash = excluded.contentHash, importedAt = excluded.importedAt, nextPath = NULL, " +
            "tags = excluded.tags, owner = excluded.owner, links = excluded.links, searchText = excluded.searchText",
        ).run(
          id,
          sourceId,
          file.path,
          file.title,
          file.type,
          key,
          snapshot.revision,
          file.hash,
          now,
          JSON.stringify(file.tags),
          file.owner,
          JSON.stringify(file.links),
          file.searchText,
        );
        db.prepare(
          "INSERT OR IGNORE INTO okf_imported_revision (conceptId, sourceRevision, objectKey, importedAt) VALUES (?, ?, ?, ?)",
        ).run(id, snapshot.revision, key, now);
      }
      markCurrent(snapshot.revision, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async function syncRepositorySource() {
    const source = repositorySource();
    if (!source) throw new Error("Connect a repository first");
    db.prepare(
      "UPDATE okf_repository_source SET status = 'syncing', error = NULL WHERE id = 'repository'",
    ).run();
    try {
      const snapshot = await repositorySync(
        `${dataDir}/sources/repository`,
        source.repositoryUrl,
        source.folder,
      );
      await importSnapshot("repository", snapshot, (revision, now) => {
        db.prepare(
          "UPDATE okf_repository_source SET status = 'current', revision = ?, lastSyncedAt = ?, error = NULL WHERE id = 'repository'",
        ).run(revision, now);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed";
      db.prepare(
        "UPDATE okf_repository_source SET status = 'sync_failed', error = ? WHERE id = 'repository'",
      ).run(message.slice(0, 500));
      throw error;
    }
  }

  let repositoryRefresh: Promise<void> | undefined;
  function refreshRepository() {
    if (repositoryRefresh) return repositoryRefresh;
    // ponytail: one source uses one process lock; use per-source jobs when multiple sources arrive.
    repositoryRefresh = syncRepositorySource().finally(() => {
      repositoryRefresh = undefined;
    });
    return repositoryRefresh;
  }

  async function syncSharedStoreSource() {
    const source = sharedSource();
    if (!source) throw new Error("Connect a shared store first");
    db.prepare(
      "UPDATE okf_shared_source SET status = 'syncing', error = NULL WHERE id = 'shared'",
    ).run();
    try {
      const credentials = await credentialVault.decrypt<{
        accessKey: string;
        secretKey: string;
      }>(source.credentialsCipher);
      const snapshot = await sharedSourceSync({
        endpoint: source.endpoint,
        bucket: source.bucket,
        path: source.path,
        region: source.region,
        ...credentials,
      });
      await importSnapshot("shared", snapshot, (revision, now) => {
        db.prepare(
          "UPDATE okf_shared_source SET status = 'current', revision = ?, lastSyncedAt = ?, error = NULL WHERE id = 'shared'",
        ).run(revision, now);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed";
      db.prepare(
        "UPDATE okf_shared_source SET status = 'sync_failed', error = ? WHERE id = 'shared'",
      ).run(message.slice(0, 500));
      throw error;
    }
  }

  let sharedRefresh: Promise<void> | undefined;
  function refreshSharedStore() {
    if (sharedRefresh) return sharedRefresh;
    sharedRefresh = syncSharedStoreSource().finally(() => {
      sharedRefresh = undefined;
    });
    return sharedRefresh;
  }

  for (const item of importedConcepts(undefined, ["current"])) {
    if (item.searchText) continue;
    try {
      const indexed = await inspectOkf(
        item.path,
        await store.get(item.objectKey),
      );
      db.prepare(
        "UPDATE okf_imported_concept SET tags = ?, owner = ?, links = ?, searchText = ? WHERE id = ?",
      ).run(
        JSON.stringify(indexed.tags),
        indexed.owner,
        JSON.stringify(indexed.links),
        indexed.searchText,
        item.id,
      );
    } catch {
      db.prepare(
        "UPDATE okf_imported_concept SET searchText = ? WHERE id = ?",
      ).run(`${item.title}\n${item.type}`, item.id);
    }
  }

  let markdown: string;
  let legacyConcept = false;
  try {
    markdown = await Deno.readTextFile(markdownPath);
    legacyConcept = true;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    markdown = DEFAULT_MARKDOWN;
  }
  if (legacyConcept && !concept()) {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO okf_concept (id, title, type, status, createdAt, updatedAt) VALUES (?, ?, ?, 'active', ?, ?)",
    ).run(CONCEPT, "Incident communication", "Policy", now, now);
  }

  try {
    Y.applyUpdate(doc, await Deno.readFile(statePath));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  let stateWrite = Promise.resolve();
  doc.on("update", () => {
    const snapshot = Y.encodeStateAsUpdate(doc);
    stateWrite = stateWrite.then(() => Deno.writeFile(statePath, snapshot));
  });

  async function saveDraft(next: string) {
    if (new TextEncoder().encode(next).byteLength > MAX_MARKDOWN_BYTES) {
      throw new MarkdownTooLarge("Markdown is too large");
    }
    markdown = `${bodyOnly(next).trimEnd()}\n`;
    const now = new Date().toISOString();
    db.prepare("UPDATE okf_concept SET updatedAt = ? WHERE id = ?").run(
      now,
      CONCEPT,
    );
    await Deno.writeTextFile(markdownPath, markdown);
  }

  async function payload(row: ConceptRow, canEdit: boolean) {
    const published = row.publishedRevision
      ? await store.get(
        revisions().find((item) => item.number === row.publishedRevision)!
          .objectKey,
      )
      : null;
    return {
      ...row,
      space: "Policies",
      draft: canEdit ? markdown : null,
      published: published ? bodyOnly(published) : null,
      revisions: canEdit ? revisions() : [],
    };
  }

  function resolveImportedLink(item: SearchDocument, href: string) {
    if (item.sourceId === "hub" || !item.path) return null;
    const target = href.split(/[?#]/, 1)[0];
    if (
      !target || target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(target)
    ) {
      return null;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      return null;
    }
    const path = normalize(
      decoded.startsWith("/")
        ? decoded.slice(1)
        : join(dirname(item.path), decoded),
    );
    if (!path || path === ".." || path.startsWith("../")) return null;
    return importedId(item.sourceId, path);
  }

  async function visibleSearchDocuments(
    userId: string,
    userName: string,
    includeArchived: boolean,
  ) {
    const documents: SearchDocument[] = [];
    const row = concept();
    const canViewHub = row && await security.check(userId, "view");
    const canEditHub = canViewHub && await security.check(userId, "edit");
    if (
      row && canViewHub &&
      (row.status === "active" || (includeArchived && canEditHub)) &&
      (canEditHub || row.publishedRevision)
    ) {
      let content = canEditHub && row.status === "active" ? markdown : "";
      if (!content && row.publishedRevision) {
        const revision = revisions().find((item) =>
          item.number === row.publishedRevision
        );
        if (revision) {
          try {
            content = bodyOnly(await store.get(revision.objectKey));
          } catch {
            // The title remains discoverable while its stored body is unavailable.
          }
        }
      }
      documents.push({
        id: CONCEPT,
        kind: "hub-native",
        sourceId: "hub",
        sourceLabel: "OKF Hub",
        sourceStatus: "current",
        title: row.title,
        type: row.type,
        tags: [],
        owner: canEditHub && !row.publishedRevision
          ? userName
          : "OKF Hub authors",
        status: row.status,
        trust: "current",
        searchText: [row.title, row.type, content].join("\n"),
        linkHrefs: [],
      });
    }

    const repository = repositorySource();
    const shared = sharedSource();
    for (const item of importedConcepts()) {
      if (!await security.check(userId, "view", item.id)) continue;
      const source = item.sourceId === "repository" ? repository : shared;
      const failed = source?.status === "sync_failed";
      documents.push({
        id: item.id,
        kind: "imported",
        sourceId: item.sourceId,
        sourceLabel: item.sourceId === "repository"
          ? repository?.repositoryUrl ?? "Git repository"
          : shared
          ? `s3://${shared.bucket}/${shared.path}`.replace(/\/$/, "")
          : "Shared store",
        sourceStatus: failed ? "sync_failed" : "current",
        title: item.title,
        type: item.type,
        tags: JSON.parse(item.tags) as string[],
        owner: item.owner ||
          (item.sourceId === "repository"
            ? "Repository owner"
            : "Shared-store owner"),
        status: "current",
        trust: failed ? "sync_failed" : "current",
        searchText: item.searchText || `${item.title}\n${item.type}`,
        path: item.path,
        sourceRevision: item.sourceRevision,
        importedAt: item.importedAt,
        linkHrefs: JSON.parse(item.links) as string[],
      });
    }
    return { documents, canIncludeArchived: Boolean(canEditHub) };
  }

  const fetch = async (request: Request): Promise<Response> => {
    if (!allowedOrigin(request)) {
      return new Response("Origin not allowed", { status: 403 });
    }
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(request) });
    }

    if (url.pathname === "/api/health") {
      return Response.json({ status: "ok", clients: clients.size }, {
        headers: cors(request),
      });
    }
    const securityResponse = await security.handle(request);
    if (securityResponse) return withCors(securityResponse, request);

    if (url.pathname === "/api/sources" && request.method === "GET") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      if (!await security.check(current.user.id, "view")) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      return Response.json({
        repository: sourcePayload("repository"),
        shared: sourcePayload("shared"),
      }, { headers: cors(request) });
    }
    if (
      url.pathname === "/api/sources/repository" && request.method === "POST"
    ) {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      if (!security.isOwner(current.user.id)) {
        return Response.json({ error: "Owner access required" }, {
          status: 403,
          headers: cors(request),
        });
      }
      const existing = repositorySource();
      if (existing?.revision) {
        return Response.json({ error: "Repository already connected" }, {
          status: 409,
          headers: cors(request),
        });
      }
      const body = await request.json().catch(() => ({})) as {
        repositoryUrl?: unknown;
        folder?: unknown;
      };
      const repositoryUrl = String(body.repositoryUrl ?? "").trim();
      const folder = String(body.folder ?? "okf").trim().replace(/^\.\//, "") ||
        ".";
      let parsed: URL;
      try {
        parsed = new URL(repositoryUrl);
      } catch {
        return Response.json({ error: "Enter a valid repository URL" }, {
          status: 400,
          headers: cors(request),
        });
      }
      if (
        parsed.protocol !== "https:" || parsed.username || parsed.password
      ) {
        return Response.json({
          error: "Use a public HTTPS Git URL without embedded credentials",
        }, { status: 400, headers: cors(request) });
      }
      if (
        folder.startsWith("/") || folder.includes("\\") ||
        folder.split("/").includes("..")
      ) {
        return Response.json({ error: "Enter a repository-relative folder" }, {
          status: 400,
          headers: cors(request),
        });
      }
      if (existing) {
        await Deno.remove(`${dataDir}/sources/repository`, { recursive: true })
          .catch((error) => {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          });
        db.prepare(
          "UPDATE okf_repository_source SET repositoryUrl = ?, folder = ?, status = 'syncing', error = NULL WHERE id = 'repository'",
        ).run(parsed.toString(), folder);
      } else {
        db.prepare(
          "INSERT INTO okf_repository_source (id, repositoryUrl, folder, status) VALUES ('repository', ?, ?, 'syncing')",
        ).run(parsed.toString(), folder);
      }
      try {
        await refreshRepository();
        return Response.json(sourcePayload("repository"), {
          status: 201,
          headers: cors(request),
        });
      } catch {
        return Response.json(sourcePayload("repository"), {
          status: 502,
          headers: cors(request),
        });
      }
    }
    if (
      url.pathname === "/api/sources/repository/refresh" &&
      request.method === "POST"
    ) {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      if (!security.isOwner(current.user.id)) {
        return Response.json({ error: "Owner access required" }, {
          status: 403,
          headers: cors(request),
        });
      }
      try {
        await refreshRepository();
        return Response.json(sourcePayload("repository"), {
          headers: cors(request),
        });
      } catch {
        return Response.json(sourcePayload("repository"), {
          status: 502,
          headers: cors(request),
        });
      }
    }
    if (url.pathname === "/api/sources/shared" && request.method === "POST") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      if (!security.isOwner(current.user.id)) {
        return Response.json({ error: "Owner access required" }, {
          status: 403,
          headers: cors(request),
        });
      }
      const existing = sharedSource();
      if (existing?.revision) {
        return Response.json({ error: "Shared store already connected" }, {
          status: 409,
          headers: cors(request),
        });
      }
      const body = await request.json().catch(() => ({})) as Record<
        string,
        unknown
      >;
      let endpoint: URL;
      try {
        endpoint = new URL(String(body.endpoint ?? "").trim());
      } catch {
        return Response.json({ error: "Enter a valid S3 endpoint" }, {
          status: 400,
          headers: cors(request),
        });
      }
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username || endpoint.password
      ) {
        return Response.json({
          error: "Use an HTTP(S) endpoint without embedded credentials",
        }, { status: 400, headers: cors(request) });
      }
      const bucket = String(body.bucket ?? "").trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,61}[a-zA-Z0-9]$/.test(bucket)) {
        return Response.json({ error: "Enter a valid S3 bucket name" }, {
          status: 400,
          headers: cors(request),
        });
      }
      const path = String(body.path ?? "okf").trim().replace(/^\.\//, "")
        .replace(/\/+$/, "");
      if (
        path.startsWith("/") || path.includes("\\") ||
        path.split("/").includes("..")
      ) {
        return Response.json({ error: "Enter a bucket-relative path" }, {
          status: 400,
          headers: cors(request),
        });
      }
      const region = String(body.region ?? "us-east-1").trim();
      if (!region || !/^[a-zA-Z0-9-]+$/.test(region)) {
        return Response.json({ error: "Enter a valid S3 region" }, {
          status: 400,
          headers: cors(request),
        });
      }
      const accessKey = String(body.accessKey ?? "").trim();
      const secretKey = String(body.secretKey ?? "");
      if (Boolean(accessKey) !== Boolean(secretKey)) {
        return Response.json({ error: "Enter both S3 credentials" }, {
          status: 400,
          headers: cors(request),
        });
      }
      if (!accessKey && !existing) {
        return Response.json({ error: "Enter S3 credentials" }, {
          status: 400,
          headers: cors(request),
        });
      }
      const credentialsCipher = accessKey
        ? await credentialVault.encrypt({ accessKey, secretKey })
        : existing!.credentialsCipher;
      if (existing) {
        db.prepare(
          "UPDATE okf_shared_source SET endpoint = ?, bucket = ?, path = ?, region = ?, credentialsCipher = ?, status = 'syncing', error = NULL WHERE id = 'shared'",
        ).run(
          endpoint.toString(),
          bucket,
          path,
          region,
          credentialsCipher,
        );
      } else {
        db.prepare(
          "INSERT INTO okf_shared_source (id, endpoint, bucket, path, region, credentialsCipher, status) VALUES ('shared', ?, ?, ?, ?, ?, 'syncing')",
        ).run(
          endpoint.toString(),
          bucket,
          path,
          region,
          credentialsCipher,
        );
      }
      try {
        await refreshSharedStore();
        return Response.json(sourcePayload("shared"), {
          status: 201,
          headers: cors(request),
        });
      } catch {
        return Response.json(sourcePayload("shared"), {
          status: 502,
          headers: cors(request),
        });
      }
    }
    if (
      url.pathname === "/api/sources/shared/refresh" &&
      request.method === "POST"
    ) {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      if (!security.isOwner(current.user.id)) {
        return Response.json({ error: "Owner access required" }, {
          status: 403,
          headers: cors(request),
        });
      }
      try {
        await refreshSharedStore();
        return Response.json(sourcePayload("shared"), {
          headers: cors(request),
        });
      } catch {
        return Response.json(sourcePayload("shared"), {
          status: 502,
          headers: cors(request),
        });
      }
    }
    if (url.pathname === "/api/imports" && request.method === "GET") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      const visible = [];
      for (const item of importedConcepts()) {
        if (await security.check(current.user.id, "view", item.id)) {
          visible.push({
            ...importedPayload(item),
            kind: "imported",
          });
        }
      }
      return Response.json(visible, { headers: cors(request) });
    }
    if (url.pathname === "/api/imported" && request.method === "GET") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      const path = url.searchParams.get("path") ?? "";
      const sourceId = url.searchParams.get("source") === "shared"
        ? "shared"
        : "repository";
      const item = db.prepare(
        "SELECT * FROM okf_imported_concept WHERE sourceId = ? AND path = ? AND status IN ('current', 'invalid')",
      ).get(sourceId, path) as ImportedConceptRow | undefined;
      if (
        !item || !await security.check(current.user.id, "view", item.id)
      ) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      try {
        const raw = await store.get(item.objectKey);
        const revisionCount = Number(
          (db.prepare(
            "SELECT COUNT(*) AS count FROM okf_imported_revision WHERE conceptId = ?",
          ).get(item.id) as { count: number }).count,
        );
        return Response.json({
          ...importedPayload(item),
          kind: "imported",
          markdown: withoutFrontmatter(raw),
          revisionCount,
          source: sourcePayload(item.sourceId),
        }, { headers: cors(request) });
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : "Storage unavailable",
        }, { status: 503, headers: cors(request) });
      }
    }
    if (url.pathname === "/api/search" && request.method === "GET") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      const query = (url.searchParams.get("q") ?? "").trim();
      if (query.length > 120) {
        return Response.json({ error: "Search is limited to 120 characters" }, {
          status: 400,
          headers: cors(request),
        });
      }
      const type = (url.searchParams.get("type") ?? "").trim()
        .toLocaleLowerCase();
      const tag = (url.searchParams.get("tag") ?? "").trim()
        .toLocaleLowerCase();
      const { documents, canIncludeArchived } = await visibleSearchDocuments(
        current.user.id,
        current.user.name,
        url.searchParams.get("includeArchived") === "true",
      );
      const visibleById = new Map(documents.map((item) => [item.id, item]));
      const outgoing = new Map<string, Set<string>>();
      const incoming = new Map<string, Set<string>>();
      for (const item of documents) {
        const targets = new Set<string>();
        for (const href of item.linkHrefs) {
          const id = resolveImportedLink(item, href);
          if (id && id !== item.id && visibleById.has(id)) targets.add(id);
        }
        outgoing.set(item.id, targets);
        for (const target of targets) {
          const sources = incoming.get(target) ?? new Set<string>();
          sources.add(item.id);
          incoming.set(target, sources);
        }
      }
      const relationship = (id: string) => {
        const item = visibleById.get(id)!;
        return {
          id: item.id,
          kind: item.kind,
          sourceId: item.sourceId,
          title: item.title,
          path: item.path,
          trust: item.trust,
          sourceLabel: item.sourceLabel,
        };
      };
      const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const results = documents.filter((item) => {
        if (type && item.type.toLocaleLowerCase() !== type) return false;
        if (
          tag &&
          !item.tags.some((itemTag) => itemTag.toLocaleLowerCase() === tag)
        ) return false;
        const haystack = item.searchText.toLocaleLowerCase();
        return terms.every((term) => haystack.includes(term));
      }).map((item) => {
        const title = item.title.toLocaleLowerCase();
        const loweredQuery = query.toLocaleLowerCase();
        const score = !query
          ? 0
          : title === loweredQuery
          ? 30
          : title.startsWith(loweredQuery)
          ? 20
          : title.includes(loweredQuery)
          ? 10
          : 1;
        const { searchText, linkHrefs: _linkHrefs, ...visible } = item;
        return {
          ...visible,
          score,
          snippet: searchSnippet(searchText, query),
          links: Array.from(outgoing.get(item.id) ?? []).map(relationship),
          backlinks: Array.from(incoming.get(item.id) ?? []).map(relationship),
        };
      }).sort((left, right) =>
        right.score - left.score || left.title.localeCompare(right.title)
      );
      return Response.json({
        query,
        results,
        facets: {
          types: Array.from(new Set(documents.map((item) => item.type))).sort(),
          tags: Array.from(new Set(documents.flatMap((item) => item.tags)))
            .sort(),
        },
        canIncludeArchived,
      }, { headers: cors(request) });
    }

    if (url.pathname === "/api/concepts" && request.method === "GET") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      if (!await security.check(current.user.id, "view")) {
        return Response.json([], { headers: cors(request) });
      }
      const row = concept();
      const canEdit = await security.check(current.user.id, "edit");
      const archived = url.searchParams.get("include") === "archived";
      const visible = row &&
        (row.status === "active"
          ? canEdit || row.publishedRevision
          : canEdit && archived);
      return Response.json(visible ? [{ ...row, space: "Policies" }] : [], {
        headers: cors(request),
      });
    }
    if (url.pathname === "/api/concepts" && request.method === "POST") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      if (!await security.check(current.user.id, "edit")) {
        return Response.json({ error: "Edit access required" }, {
          status: 403,
          headers: cors(request),
        });
      }
      if (concept()) {
        return Response.json({ error: "Concept already exists" }, {
          status: 409,
          headers: cors(request),
        });
      }
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO okf_concept (id, title, type, status, createdAt, updatedAt) VALUES (?, ?, ?, 'active', ?, ?)",
      ).run(CONCEPT, "Incident communication", "Policy", now, now);
      await Deno.writeTextFile(markdownPath, markdown);
      return Response.json(await payload(concept()!, true), {
        status: 201,
        headers: cors(request),
      });
    }
    if (
      url.pathname === `/api/concepts/${CONCEPT}` && request.method === "GET"
    ) {
      const current = await security.session(request);
      if (!current) {
        return new Response("Sign in required", {
          status: 401,
          headers: cors(request),
        });
      }
      if (!await security.check(current.user.id, "view")) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      const row = concept();
      const canEdit = await security.check(current.user.id, "edit");
      if (
        !row || (!canEdit &&
          (row.status === "archived" || !row.publishedRevision))
      ) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      try {
        return Response.json(await payload(row, canEdit), {
          headers: cors(request),
        });
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : "Storage unavailable",
        }, { status: 503, headers: cors(request) });
      }
    }
    if (
      url.pathname === `/api/concepts/${CONCEPT}` && request.method === "PUT"
    ) {
      const current = await security.session(request);
      if (!current) {
        return new Response("Sign in required", {
          status: 401,
          headers: cors(request),
        });
      }
      if (!await security.check(current.user.id, "view")) {
        return new Response("Not found", {
          status: 404,
          headers: cors(request),
        });
      }
      if (!await security.check(current.user.id, "edit")) {
        return new Response("Edit access required", {
          status: 403,
          headers: cors(request),
        });
      }
      const row = concept();
      if (!row) {
        return new Response("Not found", {
          status: 404,
          headers: cors(request),
        });
      }
      if (row.status === "archived") {
        return new Response("Restore the concept before editing", {
          status: 409,
          headers: cors(request),
        });
      }
      try {
        await saveDraft(await request.text());
        return new Response(null, { status: 204, headers: cors(request) });
      } catch (error) {
        if (error instanceof MarkdownTooLarge) {
          return new Response(error.message, {
            status: 413,
            headers: cors(request),
          });
        }
        throw error;
      }
    }
    if (
      url.pathname.startsWith(`/api/concepts/${CONCEPT}/`) &&
      request.method === "POST"
    ) {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      if (!await security.check(current.user.id, "view")) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      if (!await security.check(current.user.id, "edit")) {
        return Response.json({ error: "Edit access required" }, {
          status: 403,
          headers: cors(request),
        });
      }
      const row = concept();
      if (!row) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      try {
        if (url.pathname === `/api/concepts/${CONCEPT}/publish`) {
          if (row.status === "archived") {
            return Response.json({
              error: "Restore the concept before publishing",
            }, {
              status: 409,
              headers: cors(request),
            });
          }
          const body = await request.json().catch(() => ({})) as {
            markdown?: unknown;
          };
          await saveDraft(
            typeof body.markdown === "string" ? body.markdown : markdown,
          );
          // ponytail: one process allocates revision numbers; use a DB sequence if multi-node publishing arrives.
          const number = Number(
            (db.prepare(
              "SELECT COALESCE(MAX(number), 0) + 1 AS number FROM okf_revision WHERE conceptId = ?",
            ).get(CONCEPT) as { number: number }).number,
          );
          const publishedAt = new Date().toISOString();
          const objectKey = `policies/${CONCEPT}/revisions/${number}.md`;
          await store.put(
            objectKey,
            publishedMarkdown(markdown, current.user.id, publishedAt),
          );
          db.exec("BEGIN");
          try {
            db.prepare(
              "INSERT INTO okf_revision (conceptId, number, objectKey, publishedAt, actorUserId) VALUES (?, ?, ?, ?, ?)",
            ).run(CONCEPT, number, objectKey, publishedAt, current.user.id);
            db.prepare(
              "UPDATE okf_concept SET publishedRevision = ?, updatedAt = ? WHERE id = ?",
            ).run(number, publishedAt, CONCEPT);
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          return Response.json(await payload(concept()!, true), {
            headers: cors(request),
          });
        }
        if (url.pathname === `/api/concepts/${CONCEPT}/archive`) {
          db.prepare(
            "UPDATE okf_concept SET status = 'archived', updatedAt = ? WHERE id = ?",
          ).run(new Date().toISOString(), CONCEPT);
          clients.forEach((client) => client.close(1000, "Concept archived"));
          return Response.json(await payload(concept()!, true), {
            headers: cors(request),
          });
        }
        if (url.pathname === `/api/concepts/${CONCEPT}/restore`) {
          db.prepare(
            "UPDATE okf_concept SET status = 'active', updatedAt = ? WHERE id = ?",
          ).run(new Date().toISOString(), CONCEPT);
          return Response.json(await payload(concept()!, true), {
            headers: cors(request),
          });
        }
        const revision = url.pathname.match(/\/revisions\/(\d+)\/restore$/);
        if (revision) {
          if (row.status === "archived") {
            return Response.json({ error: "Restore the concept first" }, {
              status: 409,
              headers: cors(request),
            });
          }
          const item = db.prepare(
            "SELECT objectKey FROM okf_revision WHERE conceptId = ? AND number = ?",
          ).get(CONCEPT, Number(revision[1])) as
            | { objectKey: string }
            | undefined;
          if (!item) {
            return Response.json({ error: "Revision not found" }, {
              status: 404,
              headers: cors(request),
            });
          }
          await saveDraft(bodyOnly(await store.get(item.objectKey)));
          return Response.json(await payload(concept()!, true), {
            headers: cors(request),
          });
        }
      } catch (error) {
        const status = error instanceof MarkdownTooLarge ? 413 : 503;
        return Response.json({
          error: error instanceof Error
            ? error.message
            : "Lifecycle action failed",
        }, { status, headers: cors(request) });
      }
    }
    if (
      url.pathname === "/collab" &&
      request.headers.get("upgrade") === "websocket"
    ) {
      const current = await security.session(request);
      if (!current) return new Response("Sign in required", { status: 401 });
      if (!await security.check(current.user.id, "view")) {
        return new Response("Not found", { status: 404 });
      }
      const canEdit = await security.check(current.user.id, "edit");
      if (!canEdit) {
        return new Response("Edit access required", { status: 403 });
      }
      if (concept()?.status !== "active") {
        return new Response("Concept unavailable", { status: 409 });
      }
      const { socket, response } = Deno.upgradeWebSocket(request);
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () => {
        clients.add(socket);
        socket.send(frame(DOCUMENT_UPDATE, Y.encodeStateAsUpdate(doc)));
        socket.send("synced");
      });
      socket.addEventListener("message", async (event) => {
        if (typeof event.data === "string") return;
        const message = await bytes(event.data);
        if (!message?.length) return;
        if (message[0] === DOCUMENT_UPDATE && canEdit) {
          Y.applyUpdate(doc, message.subarray(1), socket);
        }
        if (message[0] !== DOCUMENT_UPDATE && message[0] !== AWARENESS_UPDATE) {
          return;
        }
        for (const client of clients) {
          if (client !== socket && client.readyState === WebSocket.OPEN) {
            client.send(message.slice().buffer as ArrayBuffer);
          }
        }
      });
      socket.addEventListener("close", () => clients.delete(socket));
      return response;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.split("/").includes("..")) {
        return new Response("Invalid path", { status: 400 });
      }
      const relative = decoded === "/"
        ? "index.html"
        : decoded.replace(/^\/+/, "");
      let path = `${staticDir}/${relative}`;
      let content: Uint8Array;
      try {
        content = await Deno.readFile(path);
      } catch (error) {
        if (
          !(error instanceof Deno.errors.NotFound) ||
          !request.headers.get("accept")?.includes("text/html")
        ) {
          return new Response("Not found", { status: 404 });
        }
        path = `${staticDir}/index.html`;
        try {
          content = await Deno.readFile(path);
        } catch {
          return new Response("Build the web app first", { status: 503 });
        }
      }
      const body = request.method === "HEAD" ? null : content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer;
      return new Response(body, {
        headers: {
          "content-type": CONTENT_TYPES[extension(path)] ??
            "application/octet-stream",
        },
      });
    }
    return new Response("Not found", { status: 404, headers: cors(request) });
  };

  return {
    fetch,
    close: async () => {
      clients.forEach((client) => client.close());
      await stateWrite;
      doc.destroy();
      db.close();
      security.close();
    },
  };
}

if (import.meta.main) {
  const hostname = Deno.env.get("OKF_HOST") ?? "127.0.0.1";
  const port = Number(Deno.env.get("OKF_PORT") ?? "8788");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OKF_PORT must be a valid TCP port");
  }
  const app = await createCollabApp({
    dataDir: Deno.env.get("OKF_DATA_DIR") ?? ".okf-data",
    staticDir: Deno.env.get("OKF_STATIC_DIR") ?? "dist",
    baseURL: Deno.env.get("OKF_BASE_URL") ?? `http://127.0.0.1:${port}`,
    authSecret: Deno.env.get("OKF_AUTH_SECRET") ?? undefined,
    openfgaURL: Deno.env.get("OKF_OPENFGA_URL") ?? undefined,
    openfgaKey: Deno.env.get("OKF_OPENFGA_KEY") ?? undefined,
    s3Endpoint: Deno.env.get("OKF_S3_ENDPOINT") ?? undefined,
    s3AccessKey: Deno.env.get("OKF_S3_ACCESS_KEY") ?? undefined,
    s3SecretKey: Deno.env.get("OKF_S3_SECRET_KEY") ?? undefined,
    s3Bucket: Deno.env.get("OKF_S3_BUCKET") ?? undefined,
  });
  Deno.serve({ hostname, port }, app.fetch);
}

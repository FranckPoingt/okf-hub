/// <reference lib="deno.ns" />

import * as Y from "yjs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, normalize } from "node:path/posix";
import { ArtifactInputError, createArtifactStore } from "./artifact-store.ts";
import { createCredentialVault } from "./credential-vault.ts";
import { createObjectStore } from "./object-store.ts";
import {
  inspectOkf,
  type RepositoryCredentials,
  type RepositorySnapshot,
  syncRepository,
} from "./repository-source.ts";
import { CONCEPT, createSecurity } from "./security.ts";
import { type SharedSourceConfig, syncSharedSource } from "./shared-source.ts";

const DOCUMENT_UPDATE = 0;
const AWARENESS_UPDATE = 1;
const MAX_MARKDOWN_BYTES = 512 * 1024;
const DEFAULT_AUTOMATION_INTERVAL_MS = 15 * 60 * 1000;
const MAX_SOURCE_ATTEMPTS = 2;
const DOCUMENT_INTENTS = [
  "canonical",
  "working",
  "evidence",
  "ephemeral",
] as const;
const TRACE_KINDS = ["change", "decision", "incident", "outcome"] as const;
type DocumentIntent = typeof DOCUMENT_INTENTS[number];
type WorkTraceKind = typeof TRACE_KINDS[number];

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
    remove(key: string): Promise<void>;
  };
  repositorySync?: (
    checkout: string,
    repositoryUrl: string,
    folder: string,
    credentials?: RepositoryCredentials,
  ) => Promise<RepositorySnapshot>;
  sharedSourceSync?: (
    config: SharedSourceConfig,
  ) => Promise<RepositorySnapshot>;
  automationIntervalMs?: number;
  allowedArtifactHosts?: string[];
};

type ConceptRow = {
  id: string;
  spaceId: string;
  title: string;
  type: string;
  intent: DocumentIntent;
  status: "active" | "archived";
  publishedRevision: number | null;
  updatedAt: string;
};

type WorkTraceRow = {
  id: string;
  conceptId: string;
  kind: WorkTraceKind;
  title: string;
  summary: string;
  occurredAt: string;
  sourceUrl: string;
  actorUserId: string;
  createdAt: string;
  foldedIntoConceptId: string | null;
  foldedAt: string | null;
  foldedKnowledge: string | null;
};

type SpaceRow = {
  id: string;
  name: string;
  createdAt: string;
};

type LiveDocument = {
  doc: Y.Doc;
  clients: Set<WebSocket>;
  markdown: string;
  stateWrite: Promise<void>;
};

type RevisionRow = {
  number: number;
  objectKey: string;
  publishedAt: string;
  actorUserId: string;
};

type RepositorySourceRow = {
  id: string;
  repositoryUrl: string;
  folder: string;
  credentialsCipher: string | null;
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
  sourceId: string;
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
  sourceId: string;
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

function relativeOkfPath(fromPath: string, href: string) {
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
      : join(dirname(fromPath), decoded),
  );
  return !path || path === ".." || path.startsWith("../") ? null : path;
}

export function publishedMarkdown(
  body: string,
  actorUserId: string,
  publishedAt: string,
  title = "Incident communication",
  type = "Policy",
) {
  return `---\ntype: ${type}\ntitle: ${
    JSON.stringify(title)
  }\nstatus: stable\ngenerated: { by: "human:${actorUserId}", at: "${publishedAt}" }\n---\n\n${
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
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
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
  automationIntervalMs = DEFAULT_AUTOMATION_INTERVAL_MS,
  allowedArtifactHosts = [],
}: AppOptions = {}) {
  await Deno.mkdir(dataDir, { recursive: true });
  const security = await createSecurity({
    dataDir,
    baseURL,
    authSecret,
    openfgaURL,
    openfgaKey,
  });
  const db = new DatabaseSync(`${dataDir}/hub.db`);
  const credentialVault = await createCredentialVault(dataDir);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS okf_space (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS okf_concept (
      id TEXT PRIMARY KEY,
      spaceId TEXT NOT NULL DEFAULT 'policies',
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      intent TEXT NOT NULL DEFAULT 'canonical' CHECK (intent IN ('canonical', 'working', 'evidence', 'ephemeral')),
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      publishedRevision INTEGER,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (spaceId) REFERENCES okf_space(id)
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
    CREATE TABLE IF NOT EXISTS okf_work_trace (
      id TEXT PRIMARY KEY,
      conceptId TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('change', 'decision', 'incident', 'outcome')),
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      occurredAt TEXT NOT NULL,
      sourceUrl TEXT NOT NULL DEFAULT '',
      actorUserId TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      foldedIntoConceptId TEXT,
      foldedAt TEXT,
      foldedKnowledge TEXT,
      FOREIGN KEY (conceptId) REFERENCES okf_concept(id),
      FOREIGN KEY (foldedIntoConceptId) REFERENCES okf_concept(id)
    );
    CREATE TABLE IF NOT EXISTS okf_repository_source (
      id TEXT PRIMARY KEY,
      repositoryUrl TEXT NOT NULL,
      folder TEXT NOT NULL,
      credentialsCipher TEXT,
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
      sourceId TEXT NOT NULL,
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
      sourceId TEXT NOT NULL,
      path TEXT NOT NULL,
      error TEXT NOT NULL,
      PRIMARY KEY (sourceId, path)
    );
    CREATE TABLE IF NOT EXISTS okf_automation_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial')),
      startedAt TEXT NOT NULL,
      finishedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS okf_automation_attempt (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      job TEXT NOT NULL CHECK (job IN ('source_check', 'broken_links')),
      sourceId TEXT,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
      startedAt TEXT NOT NULL,
      finishedAt TEXT,
      error TEXT,
      result TEXT,
      FOREIGN KEY (runId) REFERENCES okf_automation_run(id)
    );
  `);
  db.prepare(
    "INSERT OR IGNORE INTO okf_space (id, name, createdAt) VALUES ('policies', 'Policies', ?)",
  ).run(new Date().toISOString());
  const conceptColumns = db.prepare("PRAGMA table_info(okf_concept)").all() as {
    name: string;
  }[];
  if (!conceptColumns.some(({ name }) => name === "spaceId")) {
    db.exec(
      "ALTER TABLE okf_concept ADD COLUMN spaceId TEXT NOT NULL DEFAULT 'policies'",
    );
  }
  if (!conceptColumns.some(({ name }) => name === "intent")) {
    db.exec(
      "ALTER TABLE okf_concept ADD COLUMN intent TEXT NOT NULL DEFAULT 'canonical' CHECK (intent IN ('canonical', 'working', 'evidence', 'ephemeral'))",
    );
  }
  const repositoryColumns = db.prepare(
    "PRAGMA table_info(okf_repository_source)",
  ).all() as { name: string }[];
  if (!repositoryColumns.some(({ name }) => name === "credentialsCipher")) {
    db.exec(
      "ALTER TABLE okf_repository_source ADD COLUMN credentialsCipher TEXT",
    );
  }
  const repositorySchema = String(
    (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'okf_repository_source'",
    ).get() as { sql?: string } | undefined)?.sql ?? "",
  );
  if (repositorySchema.includes("CHECK (id = 'repository')")) {
    db.exec(`
      BEGIN;
      ALTER TABLE okf_repository_source RENAME TO okf_repository_source_legacy;
      CREATE TABLE okf_repository_source (
        id TEXT PRIMARY KEY,
        repositoryUrl TEXT NOT NULL,
        folder TEXT NOT NULL,
        credentialsCipher TEXT,
        status TEXT NOT NULL CHECK (status IN ('syncing', 'current', 'sync_failed')),
        revision TEXT,
        lastSyncedAt TEXT,
        error TEXT
      );
      INSERT INTO okf_repository_source SELECT * FROM okf_repository_source_legacy;
      DROP TABLE okf_repository_source_legacy;
      COMMIT;
    `);
  }
  const importedColumns = db.prepare("PRAGMA table_info(okf_imported_concept)")
    .all() as { name: string }[];
  if (!importedColumns.some(({ name }) => name === "sourceId")) {
    db.exec(`
      BEGIN;
      ALTER TABLE okf_imported_concept RENAME TO okf_imported_concept_legacy;
      CREATE TABLE okf_imported_concept (
        id TEXT PRIMARY KEY,
        sourceId TEXT NOT NULL,
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
        sourceId TEXT NOT NULL,
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
  const importedSchema = String(
    (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'okf_imported_concept'",
    ).get() as { sql?: string } | undefined)?.sql ?? "",
  );
  if (importedSchema.includes("sourceId IN ('repository', 'shared')")) {
    db.exec(`
      BEGIN;
      ALTER TABLE okf_imported_concept RENAME TO okf_imported_concept_legacy;
      CREATE TABLE okf_imported_concept (
        id TEXT PRIMARY KEY,
        sourceId TEXT NOT NULL,
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
      INSERT INTO okf_imported_concept SELECT * FROM okf_imported_concept_legacy;
      DROP TABLE okf_imported_concept_legacy;
      ALTER TABLE okf_import_issue RENAME TO okf_import_issue_legacy;
      CREATE TABLE okf_import_issue (
        sourceId TEXT NOT NULL,
        path TEXT NOT NULL,
        error TEXT NOT NULL,
        PRIMARY KEY (sourceId, path)
      );
      INSERT INTO okf_import_issue SELECT * FROM okf_import_issue_legacy;
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
  const artifactStore = createArtifactStore(db, allowedArtifactHosts);
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
        remove: () =>
          Promise.reject(new Error("Object storage is not configured")),
      });

  const concept = (id = CONCEPT) =>
    db.prepare("SELECT * FROM okf_concept WHERE id = ?").get(id) as
      | ConceptRow
      | undefined;
  const concepts = () =>
    db.prepare("SELECT * FROM okf_concept ORDER BY title")
      .all() as ConceptRow[];
  const space = (id: string) =>
    db.prepare("SELECT * FROM okf_space WHERE id = ?").get(id) as
      | SpaceRow
      | undefined;
  const spaces = () =>
    db.prepare("SELECT * FROM okf_space ORDER BY name").all() as SpaceRow[];
  const revisions = (conceptId: string) =>
    db.prepare(
      "SELECT number, objectKey, publishedAt, actorUserId FROM okf_revision WHERE conceptId = ? ORDER BY number DESC",
    ).all(conceptId) as RevisionRow[];
  const workTrace = (id: string) =>
    db.prepare("SELECT * FROM okf_work_trace WHERE id = ?").get(id) as
      | WorkTraceRow
      | undefined;
  const repositorySource = (id: string) =>
    db.prepare("SELECT * FROM okf_repository_source WHERE id = ?")
      .get(id) as RepositorySourceRow | undefined;
  const repositorySources = () =>
    db.prepare("SELECT * FROM okf_repository_source ORDER BY repositoryUrl")
      .all() as RepositorySourceRow[];
  const sharedSource = () =>
    db.prepare("SELECT * FROM okf_shared_source WHERE id = 'shared'").get() as
      | SharedSourceRow
      | undefined;
  const importedConcepts = (
    sourceId?: string,
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

  function sourcePayload(sourceId: string) {
    const source = sourceId === "shared"
      ? sharedSource()
      : repositorySource(sourceId);
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
    return sourceId !== "shared"
      ? {
        ...common,
        kind: "git",
        repositoryUrl: (source as RepositorySourceRow).repositoryUrl,
        folder: (source as RepositorySourceRow).folder,
        credentialsConfigured: Boolean(
          (source as RepositorySourceRow).credentialsCipher,
        ),
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

  async function canViewSource(userId: string, sourceId: string) {
    if (security.isOwner(userId)) return true;
    if (
      await security.checkSpace(
        userId,
        "view",
        `imported-${sourceId}`,
      )
    ) return true;
    for (const item of importedConcepts(sourceId, ["current", "invalid"])) {
      if (await security.check(userId, "view", item.id)) return true;
    }
    return false;
  }

  async function importSnapshot(
    sourceId: string,
    snapshot: RepositorySnapshot,
    markCurrent: (revision: string, now: string) => void,
  ) {
    for (const file of snapshot.files) {
      await store.put(
        importedObjectKey(sourceId, snapshot.revision, file.path),
        file.markdown,
      );
      await security.ensureImportedConcept(
        sourceId,
        importedId(sourceId, file.path),
      );
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

  async function syncRepositorySource(sourceId: string) {
    const source = repositorySource(sourceId);
    if (!source) throw new Error("Connect a repository first");
    db.prepare(
      "UPDATE okf_repository_source SET status = 'syncing', error = NULL WHERE id = ?",
    ).run(sourceId);
    try {
      const credentials = source.credentialsCipher
        ? await credentialVault.decrypt<RepositoryCredentials>(
          source.credentialsCipher,
        )
        : undefined;
      const snapshot = await repositorySync(
        `${dataDir}/sources/${sourceId}`,
        source.repositoryUrl,
        source.folder,
        credentials,
      );
      await importSnapshot(sourceId, snapshot, (revision, now) => {
        db.prepare(
          "UPDATE okf_repository_source SET status = 'current', revision = ?, lastSyncedAt = ?, error = NULL WHERE id = ?",
        ).run(revision, now, sourceId);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed";
      db.prepare(
        "UPDATE okf_repository_source SET status = 'sync_failed', error = ? WHERE id = ?",
      ).run(message.slice(0, 500), sourceId);
      throw error;
    }
  }

  const repositoryRefreshes = new Map<string, Promise<void>>();
  function refreshRepository(sourceId: string) {
    const active = repositoryRefreshes.get(sourceId);
    if (active) return active;
    const refresh = syncRepositorySource(sourceId).finally(() => {
      repositoryRefreshes.delete(sourceId);
    });
    repositoryRefreshes.set(sourceId, refresh);
    return refresh;
  }

  async function disconnectRepository(sourceId: string) {
    const concepts = importedConcepts(sourceId, [
      "current",
      "invalid",
      "deleted",
      "renamed",
    ]);
    const objects = db.prepare(
      "SELECT revision.objectKey FROM okf_imported_revision revision JOIN okf_imported_concept concept ON concept.id = revision.conceptId WHERE concept.sourceId = ? UNION SELECT objectKey FROM okf_imported_concept WHERE sourceId = ?",
    ).all(sourceId, sourceId) as { objectKey: string }[];
    await security.deleteImportedSource(
      sourceId,
      concepts.map((concept) => concept.id),
    );
    db.exec("BEGIN");
    try {
      db.prepare(
        "DELETE FROM okf_imported_revision WHERE conceptId IN (SELECT id FROM okf_imported_concept WHERE sourceId = ?)",
      ).run(sourceId);
      db.prepare("DELETE FROM okf_import_issue WHERE sourceId = ?").run(
        sourceId,
      );
      db.prepare("DELETE FROM okf_imported_concept WHERE sourceId = ?").run(
        sourceId,
      );
      db.prepare("DELETE FROM okf_repository_source WHERE id = ?").run(
        sourceId,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    // ponytail: inaccessible orphan cleanup is best-effort; persist cleanup jobs if failures become operationally relevant.
    await Promise.allSettled([
      ...objects.map(({ objectKey }) => store.remove(objectKey)),
      Deno.remove(`${dataDir}/sources/${sourceId}`, { recursive: true }).catch(
        (error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        },
      ),
    ]);
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

  function automationOwner() {
    const members = db.prepare("SELECT userId, role FROM member").all() as {
      userId: string;
      role: string;
    }[];
    return members.find((item) => item.role.split(",").includes("owner"))
      ?.userId;
  }

  function automationHistory() {
    const runs = db.prepare(
      "SELECT * FROM okf_automation_run ORDER BY id DESC LIMIT 20",
    ).all() as (Record<string, unknown> & { id: number })[];
    const attempts = db.prepare(
      "SELECT * FROM okf_automation_attempt WHERE runId = ? ORDER BY id",
    );
    return runs.map((run) => ({
      ...run,
      attempts: (attempts.all(run.id) as Record<string, unknown>[]).map(
        (attempt) => ({
          ...attempt,
          result: attempt.result ? JSON.parse(String(attempt.result)) : null,
        }),
      ),
    }));
  }

  async function checkSource(
    runId: number,
    sourceId: string,
  ) {
    for (let attempt = 1; attempt <= MAX_SOURCE_ATTEMPTS; attempt++) {
      const startedAt = new Date().toISOString();
      const id = Number(
        db.prepare(
          "INSERT INTO okf_automation_attempt (runId, job, sourceId, attempt, status, startedAt) VALUES (?, 'source_check', ?, ?, 'running', ?)",
        ).run(runId, sourceId, attempt, startedAt).lastInsertRowid,
      );
      try {
        await (sourceId !== "shared"
          ? refreshRepository(sourceId)
          : refreshSharedStore());
        const source = sourcePayload(sourceId)!;
        db.prepare(
          "UPDATE okf_automation_attempt SET status = 'succeeded', finishedAt = ?, result = ? WHERE id = ?",
        ).run(
          new Date().toISOString(),
          JSON.stringify({
            revision: source.revision,
            conceptCount: source.conceptCount,
          }),
          id,
        );
        return true;
      } catch (error) {
        db.prepare(
          "UPDATE okf_automation_attempt SET status = 'failed', finishedAt = ?, error = ? WHERE id = ?",
        ).run(
          new Date().toISOString(),
          (error instanceof Error ? error.message : "Source check failed")
            .slice(
              0,
              500,
            ),
          id,
        );
      }
    }
    return false;
  }

  async function checkBrokenLinks(runId: number, actorUserId: string) {
    const startedAt = new Date().toISOString();
    const id = Number(
      db.prepare(
        "INSERT INTO okf_automation_attempt (runId, job, attempt, status, startedAt) VALUES (?, 'broken_links', 1, 'running', ?)",
      ).run(runId, startedAt).lastInsertRowid,
    );
    try {
      const visible = [];
      for (const item of importedConcepts()) {
        if (await security.check(actorUserId, "view", item.id)) {
          visible.push(item);
        }
      }
      const paths = new Set(
        visible.map((item) => `${item.sourceId}:${item.path}`),
      );
      const proposals = [];
      for (const item of visible) {
        for (const href of JSON.parse(item.links) as string[]) {
          const target = relativeOkfPath(item.path, href);
          if (!target || paths.has(`${item.sourceId}:${target}`)) continue;
          proposals.push({
            sourceId: item.sourceId,
            path: item.path,
            href,
            target,
            action: "fix_broken_link",
          });
        }
      }
      db.prepare(
        "UPDATE okf_automation_attempt SET status = 'succeeded', finishedAt = ?, result = ? WHERE id = ?",
      ).run(
        new Date().toISOString(),
        JSON.stringify({ checkedConcepts: visible.length, proposals }),
        id,
      );
      return true;
    } catch (error) {
      db.prepare(
        "UPDATE okf_automation_attempt SET status = 'failed', finishedAt = ?, error = ? WHERE id = ?",
      ).run(
        new Date().toISOString(),
        (error instanceof Error ? error.message : "Link check failed").slice(
          0,
          500,
        ),
        id,
      );
      return false;
    }
  }

  let activeAutomation: Promise<void> | undefined;
  function startAutomation(
    trigger: "manual" | "scheduled",
    actorUserId: string,
  ) {
    if (activeAutomation) return null;
    const work = async () => {
      const startedAt = new Date().toISOString();
      const runId = Number(
        db.prepare(
          "INSERT INTO okf_automation_run (trigger, status, startedAt) VALUES (?, 'running', ?)",
        ).run(trigger, startedAt).lastInsertRowid,
      );
      try {
        const jobs: Promise<boolean>[] = [];
        for (const source of repositorySources()) {
          jobs.push(checkSource(runId, source.id));
        }
        if (sharedSource()) jobs.push(checkSource(runId, "shared"));
        jobs.push(checkBrokenLinks(runId, actorUserId));
        const results = await Promise.all(jobs);
        db.prepare(
          "UPDATE okf_automation_run SET status = ?, finishedAt = ? WHERE id = ?",
        ).run(
          results.every(Boolean) ? "succeeded" : "partial",
          new Date().toISOString(),
          runId,
        );
      } catch (error) {
        db.prepare(
          "UPDATE okf_automation_run SET status = 'partial', finishedAt = ? WHERE id = ?",
        ).run(new Date().toISOString(), runId);
        throw error;
      }
    };
    activeAutomation = work().finally(() => {
      activeAutomation = undefined;
    });
    return activeAutomation;
  }

  const automationTimer = automationIntervalMs > 0
    ? setInterval(() => {
      const owner = automationOwner();
      const run = owner ? startAutomation("scheduled", owner) : null;
      if (run) {
        void run.catch((error) =>
          console.error("Scheduled source checks failed", error)
        );
      }
    }, automationIntervalMs)
    : undefined;

  const legacyMarkdownPath = `${dataDir}/incident-communication.md`;
  const legacyStatePath = `${dataDir}/incident-communication.yjs`;
  let legacyMarkdown: string | undefined;
  try {
    legacyMarkdown = await Deno.readTextFile(legacyMarkdownPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (legacyMarkdown && !concept()) {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO okf_concept (id, spaceId, title, type, status, createdAt, updatedAt) VALUES (?, 'policies', ?, ?, 'active', ?, ?)",
    ).run(CONCEPT, "Incident communication", "Policy", now, now);
  }

  await Deno.mkdir(`${dataDir}/concepts`, { recursive: true });
  const documents = new Map<string, LiveDocument>();
  const markdownPath = (id: string) =>
    id === CONCEPT
      ? legacyMarkdownPath
      : `${dataDir}/concepts/${encodeURIComponent(id)}.md`;
  const statePath = (id: string) =>
    id === CONCEPT
      ? legacyStatePath
      : `${dataDir}/concepts/${encodeURIComponent(id)}.yjs`;

  async function loadDocument(row: ConceptRow, fallback?: string) {
    const loaded = documents.get(row.id);
    if (loaded) return loaded;
    let markdown: string;
    try {
      markdown = await Deno.readTextFile(markdownPath(row.id));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      markdown = fallback ?? `# ${row.title}\n`;
    }
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, await Deno.readFile(statePath(row.id)));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const live: LiveDocument = {
      doc,
      clients: new Set(),
      markdown,
      stateWrite: Promise.resolve(),
    };
    doc.on("update", () => {
      const snapshot = Y.encodeStateAsUpdate(doc);
      live.stateWrite = live.stateWrite.then(() =>
        Deno.writeFile(statePath(row.id), snapshot)
      );
    });
    documents.set(row.id, live);
    return live;
  }

  for (const row of concepts()) {
    await loadDocument(row, row.id === CONCEPT ? DEFAULT_MARKDOWN : undefined);
  }

  async function saveDraft(conceptId: string, next: string) {
    if (new TextEncoder().encode(next).byteLength > MAX_MARKDOWN_BYTES) {
      throw new MarkdownTooLarge("Markdown is too large");
    }
    const row = concept(conceptId);
    if (!row) throw new Error("Concept not found");
    const live = await loadDocument(row);
    live.markdown = `${bodyOnly(next).trimEnd()}\n`;
    const now = new Date().toISOString();
    db.prepare("UPDATE okf_concept SET updatedAt = ? WHERE id = ?").run(
      now,
      conceptId,
    );
    await Deno.writeTextFile(markdownPath(conceptId), live.markdown);
  }

  async function visibleWorkTraces(conceptId: string, userId: string) {
    const rows = db.prepare(
      "SELECT trace.*, source.title AS conceptTitle, target.title AS foldedIntoTitle FROM okf_work_trace trace JOIN okf_concept source ON source.id = trace.conceptId LEFT JOIN okf_concept target ON target.id = trace.foldedIntoConceptId WHERE trace.conceptId = ? OR trace.foldedIntoConceptId = ? ORDER BY trace.occurredAt DESC, trace.createdAt DESC",
    ).all(conceptId, conceptId) as (WorkTraceRow & {
      conceptTitle: string;
      foldedIntoTitle: string | null;
    })[];
    const visible = [];
    for (const trace of rows) {
      if (await security.check(userId, "view", trace.conceptId)) {
        const targetVisible = !trace.foldedIntoConceptId ||
          await security.check(userId, "view", trace.foldedIntoConceptId);
        visible.push(
          targetVisible ? trace : {
            ...trace,
            foldedIntoConceptId: null,
            foldedIntoTitle: null,
            foldedAt: null,
            foldedKnowledge: null,
          },
        );
      }
    }
    return visible;
  }

  async function payload(row: ConceptRow, canEdit: boolean, userId: string) {
    const live = await loadDocument(row);
    const history = revisions(row.id);
    const traces = await visibleWorkTraces(row.id, userId);
    const published = row.publishedRevision
      ? await store.get(
        history.find((item) => item.number === row.publishedRevision)!
          .objectKey,
      )
      : null;
    return {
      ...row,
      space: space(row.spaceId)?.name ?? row.spaceId,
      draft: canEdit ? live.markdown : null,
      published: published ? bodyOnly(published) : null,
      revisions: canEdit ? history : [],
      workTraces: canEdit
        ? traces
        : traces.map((trace) => ({ ...trace, foldedKnowledge: null })),
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
    let canIncludeArchived = false;
    for (const row of concepts()) {
      const canViewHub = await security.check(userId, "view", row.id);
      const canEditHub = canViewHub &&
        await security.check(userId, "edit", row.id);
      canIncludeArchived ||= Boolean(canEditHub);
      if (
        canViewHub &&
        (row.status === "active" || (includeArchived && canEditHub)) &&
        (canEditHub || row.publishedRevision)
      ) {
        let content = canEditHub && row.status === "active"
          ? (await loadDocument(row)).markdown
          : "";
        if (!content && row.publishedRevision) {
          const revision = revisions(row.id).find((item) =>
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
          id: row.id,
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
    }

    const shared = sharedSource();
    for (const item of importedConcepts()) {
      if (!await security.check(userId, "view", item.id)) continue;
      const repository = item.sourceId === "shared"
        ? undefined
        : repositorySource(item.sourceId);
      const source = repository ?? shared;
      const failed = source?.status === "sync_failed";
      documents.push({
        id: item.id,
        kind: "imported",
        sourceId: item.sourceId,
        sourceLabel: item.sourceId !== "shared"
          ? repository?.repositoryUrl ?? "Git repository"
          : shared
          ? `s3://${shared.bucket}/${shared.path}`.replace(/\/$/, "")
          : "Shared store",
        sourceStatus: failed ? "sync_failed" : "current",
        title: item.title,
        type: item.type,
        tags: JSON.parse(item.tags) as string[],
        owner: item.owner ||
          (item.sourceId !== "shared"
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
    return { documents, canIncludeArchived };
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
      const clients = Array.from(documents.values()).reduce(
        (total, item) => total + item.clients.size,
        0,
      );
      return Response.json({ status: "ok", clients }, {
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
      const repositories = [];
      for (const source of repositorySources()) {
        if (await canViewSource(current.user.id, source.id)) {
          repositories.push(sourcePayload(source.id));
        }
      }
      return Response.json({
        repositories,
        shared: sharedSource() &&
            await canViewSource(current.user.id, "shared")
          ? sourcePayload("shared")
          : null,
      }, { headers: cors(request) });
    }
    const repositoryPath = url.pathname.match(
      /^\/api\/sources\/repositories(?:\/([a-z0-9-]+))?$/,
    );
    if (repositoryPath?.[1] && request.method === "DELETE") {
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
      const sourceId = repositoryPath[1];
      if (!repositorySource(sourceId)) {
        return Response.json({ error: "Repository not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      const body = await request.json().catch(() => ({})) as {
        confirm?: unknown;
      };
      if (body.confirm !== sourceId) {
        return Response.json({ error: "Confirm the repository source ID" }, {
          status: 400,
          headers: cors(request),
        });
      }
      if (repositoryRefreshes.has(sourceId)) {
        return Response.json(
          { error: "Wait for repository refresh to finish" },
          {
            status: 409,
            headers: cors(request),
          },
        );
      }
      await disconnectRepository(sourceId);
      return new Response(null, { status: 204, headers: cors(request) });
    }
    if (repositoryPath && request.method === "POST") {
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
      const existing = repositoryPath[1]
        ? repositorySource(repositoryPath[1])
        : undefined;
      if (repositoryPath[1] && !existing) {
        return Response.json({ error: "Repository not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      const body = await request.json().catch(() => ({})) as {
        repositoryUrl?: unknown;
        folder?: unknown;
        username?: unknown;
        token?: unknown;
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
          error: "Use an HTTPS Git URL without embedded credentials",
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
      const username = String(body.username ?? "").trim();
      const token = String(body.token ?? "");
      if (Boolean(username) !== Boolean(token)) {
        return Response.json({
          error: "Enter both Git username and access token",
        }, {
          status: 400,
          headers: cors(request),
        });
      }
      if (username.length > 256 || token.length > 4096) {
        return Response.json({ error: "Git credentials are too long" }, {
          status: 400,
          headers: cors(request),
        });
      }
      if (
        existing?.revision &&
        (existing.repositoryUrl !== parsed.toString() ||
          existing.folder !== folder)
      ) {
        return Response.json({ error: "Repository already connected" }, {
          status: 409,
          headers: cors(request),
        });
      }
      const credentialsCipher = username
        ? await credentialVault.encrypt({ username, token })
        : existing?.credentialsCipher ?? null;
      const sourceId = existing?.id ??
        (repositorySources().length
          ? `repository-${crypto.randomUUID()}`
          : "repository");
      if (existing) {
        if (
          existing.repositoryUrl !== parsed.toString() ||
          existing.folder !== folder
        ) {
          await Deno.remove(`${dataDir}/sources/${sourceId}`, {
            recursive: true,
          }).catch((error) => {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          });
        }
        db.prepare(
          "UPDATE okf_repository_source SET repositoryUrl = ?, folder = ?, credentialsCipher = ?, status = 'syncing', error = NULL WHERE id = ?",
        ).run(parsed.toString(), folder, credentialsCipher, sourceId);
      } else {
        db.prepare(
          "INSERT INTO okf_repository_source (id, repositoryUrl, folder, credentialsCipher, status) VALUES (?, ?, ?, ?, 'syncing')",
        ).run(sourceId, parsed.toString(), folder, credentialsCipher);
      }
      try {
        await refreshRepository(sourceId);
        return Response.json(sourcePayload(sourceId), {
          status: existing ? 200 : 201,
          headers: cors(request),
        });
      } catch {
        return Response.json(sourcePayload(sourceId), {
          status: 502,
          headers: cors(request),
        });
      }
    }
    const repositoryRefreshPath = url.pathname.match(
      /^\/api\/sources\/repositories\/([a-z0-9-]+)\/refresh$/,
    );
    if (repositoryRefreshPath && request.method === "POST") {
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
      const sourceId = repositoryRefreshPath[1];
      if (!repositorySource(sourceId)) {
        return Response.json({ error: "Repository not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      try {
        await refreshRepository(sourceId);
        return Response.json(sourcePayload(sourceId), {
          headers: cors(request),
        });
      } catch {
        return Response.json(sourcePayload(sourceId), {
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
    if (url.pathname === "/api/automation" && request.method === "GET") {
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
      return Response.json({
        intervalMs: automationIntervalMs,
        running: Boolean(activeAutomation),
        runs: automationHistory(),
      }, { headers: cors(request) });
    }
    if (
      url.pathname === "/api/automation/run" && request.method === "POST"
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
      const automation = startAutomation("manual", current.user.id);
      if (!automation) {
        return Response.json({ error: "An automation run is already active" }, {
          status: 409,
          headers: cors(request),
        });
      }
      try {
        await automation;
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : "Automation failed",
        }, { status: 503, headers: cors(request) });
      }
      return Response.json({
        intervalMs: automationIntervalMs,
        running: false,
        runs: automationHistory(),
      }, { headers: cors(request) });
    }
    if (url.pathname === "/api/artifacts" && request.method === "GET") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      const conceptId = url.searchParams.get("conceptId") ?? "";
      if (
        !conceptId || !await security.check(current.user.id, "view", conceptId)
      ) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      const row = concept(conceptId);
      const canEdit = await security.check(current.user.id, "edit", conceptId);
      if (
        !row ||
        (!canEdit && (row.status === "archived" || !row.publishedRevision))
      ) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      return Response.json({
        artifacts: artifactStore.list(conceptId, canEdit),
        allowedHosts: canEdit ? artifactStore.allowedHosts : [],
        canEdit,
        canPublish: canEdit && security.isOwner(current.user.id),
      }, { headers: cors(request) });
    }
    if (url.pathname === "/api/artifacts" && request.method === "POST") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      const body = await request.json().catch(() => ({})) as Record<
        string,
        unknown
      >;
      const conceptId = String(body.conceptId ?? "");
      if (
        !conceptId || !await security.check(current.user.id, "view", conceptId)
      ) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      if (!await security.check(current.user.id, "edit", conceptId)) {
        return Response.json({ error: "Edit access required" }, {
          status: 403,
          headers: cors(request),
        });
      }
      if (concept(conceptId)?.status !== "active") {
        return Response.json({ error: "Restore the concept first" }, {
          status: 409,
          headers: cors(request),
        });
      }
      if (body.type !== "inline_html" && body.type !== "https_url") {
        return Response.json({ error: "Choose an artifact type" }, {
          status: 400,
          headers: cors(request),
        });
      }
      try {
        const artifact = artifactStore.create({
          conceptId,
          title: String(body.title ?? ""),
          type: body.type,
          content: String(body.content ?? ""),
          actorUserId: current.user.id,
        });
        security.audit(
          current.user.id,
          "artifact.created",
          `artifact:${artifact!.id}`,
        );
        return Response.json(artifact, { status: 201, headers: cors(request) });
      } catch (error) {
        return Response.json({
          error: error instanceof Error
            ? error.message
            : "Artifact creation failed",
        }, {
          status: error instanceof ArtifactInputError ? 400 : 503,
          headers: cors(request),
        });
      }
    }
    const artifactPublish = url.pathname.match(
      /^\/api\/artifacts\/([^/]+)\/publish$/,
    );
    if (artifactPublish && request.method === "POST") {
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
      const id = decodeURIComponent(artifactPublish[1]);
      const conceptId = artifactStore.conceptId(id);
      if (
        !conceptId || !await security.check(current.user.id, "edit", conceptId)
      ) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      if (concept(conceptId)?.status !== "active") {
        return Response.json({ error: "Restore the concept first" }, {
          status: 409,
          headers: cors(request),
        });
      }
      const artifact = artifactStore.publish(id, current.user.id);
      if (!artifact) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      security.audit(
        current.user.id,
        "artifact.published",
        `artifact:${id}:version:${artifact.version}`,
      );
      return Response.json(artifact, { headers: cors(request) });
    }
    const artifactRevision = url.pathname.match(/^\/api\/artifacts\/([^/]+)$/);
    if (artifactRevision && request.method === "PUT") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      const id = decodeURIComponent(artifactRevision[1]);
      const conceptId = artifactStore.conceptId(id);
      if (
        !conceptId || !await security.check(current.user.id, "view", conceptId)
      ) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      if (!await security.check(current.user.id, "edit", conceptId)) {
        return Response.json({ error: "Edit access required" }, {
          status: 403,
          headers: cors(request),
        });
      }
      if (concept(conceptId)?.status !== "active") {
        return Response.json({ error: "Restore the concept first" }, {
          status: 409,
          headers: cors(request),
        });
      }
      const body = await request.json().catch(() => ({})) as {
        content?: unknown;
      };
      try {
        const artifact = artifactStore.revise(
          id,
          String(body.content ?? ""),
          current.user.id,
        );
        if (!artifact) {
          return Response.json({ error: "Not found" }, {
            status: 404,
            headers: cors(request),
          });
        }
        security.audit(
          current.user.id,
          "artifact.revised",
          `artifact:${id}:version:${artifact.version}`,
        );
        return Response.json(artifact, { headers: cors(request) });
      } catch (error) {
        return Response.json({
          error: error instanceof Error
            ? error.message
            : "Artifact update failed",
        }, {
          status: error instanceof ArtifactInputError ? 400 : 503,
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
      const sourceId = (url.searchParams.get("source") ?? "repository").trim();
      if (!/^[a-z0-9-]+$/.test(sourceId)) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
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

    if (url.pathname === "/api/spaces" && request.method === "GET") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      const visible = [];
      for (const item of spaces()) {
        if (!await security.checkSpace(current.user.id, "view", item.id)) {
          continue;
        }
        let count = 0;
        for (const row of concepts().filter((row) => row.spaceId === item.id)) {
          if (
            await security.check(current.user.id, "view", row.id) &&
            (await security.check(current.user.id, "edit", row.id) ||
              (row.status === "active" && row.publishedRevision))
          ) count++;
        }
        visible.push({ ...item, count });
      }
      return Response.json(visible, { headers: cors(request) });
    }
    if (url.pathname === "/api/spaces" && request.method === "POST") {
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
      const body = await request.json().catch(() => ({})) as {
        name?: unknown;
      };
      const name = String(body.name ?? "").trim();
      if (!name || name.length > 60) {
        return Response.json({ error: "Space name must be 1–60 characters" }, {
          status: 400,
          headers: cors(request),
        });
      }
      const baseId = name.toLocaleLowerCase().normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "space";
      const id = space(baseId)
        ? `${baseId}-${crypto.randomUUID().slice(0, 6)}`
        : baseId;
      try {
        await security.ensureHubSpace(id);
        const now = new Date().toISOString();
        db.prepare(
          "INSERT INTO okf_space (id, name, createdAt) VALUES (?, ?, ?)",
        ).run(id, name, now);
        security.audit(current.user.id, "space.created", `space:${id}`);
        return Response.json({ id, name, createdAt: now, count: 0 }, {
          status: 201,
          headers: cors(request),
        });
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : "Creation failed",
        }, { status: 503, headers: cors(request) });
      }
    }
    const spaceRoute = url.pathname.match(/^\/api\/spaces\/([a-z0-9-]+)$/);
    if (spaceRoute && request.method === "PUT") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      const spaceId = spaceRoute[1];
      const item = space(spaceId);
      if (
        !item || !await security.checkSpace(current.user.id, "edit", spaceId)
      ) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      const body = await request.json().catch(() => ({})) as {
        name?: unknown;
      };
      const name = String(body.name ?? "").trim();
      if (!name || name.length > 60) {
        return Response.json({ error: "Space name must be 1–60 characters" }, {
          status: 400,
          headers: cors(request),
        });
      }
      db.prepare("UPDATE okf_space SET name = ? WHERE id = ?").run(
        name,
        spaceId,
      );
      security.audit(current.user.id, "space.renamed", `space:${spaceId}`);
      return Response.json({ ...item, name }, { headers: cors(request) });
    }
    if (spaceRoute && request.method === "DELETE") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      const spaceId = spaceRoute[1];
      const item = space(spaceId);
      if (
        !item || !await security.checkSpace(current.user.id, "edit", spaceId)
      ) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      if (spaceId === "policies") {
        return Response.json({ error: "The default space cannot be deleted" }, {
          status: 409,
          headers: cors(request),
        });
      }
      if (concepts().some((row) => row.spaceId === spaceId)) {
        return Response.json({ error: "Move every document out first" }, {
          status: 409,
          headers: cors(request),
        });
      }
      try {
        await security.deleteHubSpace(spaceId);
        db.prepare("DELETE FROM okf_space WHERE id = ?").run(spaceId);
        security.audit(current.user.id, "space.deleted", `space:${spaceId}`);
        return new Response(null, { status: 204, headers: cors(request) });
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : "Deletion failed",
        }, { status: 503, headers: cors(request) });
      }
    }

    if (url.pathname === "/api/concepts" && request.method === "GET") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      const archived = url.searchParams.get("include") === "archived";
      const visible = [];
      for (const row of concepts()) {
        if (!await security.check(current.user.id, "view", row.id)) continue;
        const canEdit = await security.check(current.user.id, "edit", row.id);
        if (
          row.status === "active"
            ? canEdit || row.publishedRevision
            : canEdit && archived
        ) {
          visible.push({
            ...row,
            space: space(row.spaceId)?.name ?? row.spaceId,
          });
        }
      }
      return Response.json(visible, {
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
      const body = await request.json().catch(() => ({})) as Record<
        string,
        unknown
      >;
      const spaceId = String(body.spaceId ?? "policies");
      const targetSpace = space(spaceId);
      if (
        !targetSpace ||
        !await security.checkSpace(current.user.id, "edit", spaceId)
      ) {
        return Response.json({ error: "Edit access required" }, {
          status: 403,
          headers: cors(request),
        });
      }
      const title = String(body.title ?? "Incident communication").trim();
      const type = String(body.type ?? "Policy").trim();
      const intent = String(body.intent ?? "canonical") as DocumentIntent;
      if (
        !title || title.length > 100 ||
        !/^[A-Za-z][A-Za-z0-9 _-]{0,49}$/.test(type) ||
        !DOCUMENT_INTENTS.includes(intent)
      ) {
        return Response.json({
          error: "Title and type are required and must fit their fields",
        }, { status: 400, headers: cors(request) });
      }
      const baseId = title.toLocaleLowerCase().normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "concept";
      const id = Object.keys(body).length === 0
        ? CONCEPT
        : concept(baseId)
        ? `${baseId}-${crypto.randomUUID().slice(0, 6)}`
        : baseId;
      if (concept(id)) {
        return Response.json({ error: "Concept already exists" }, {
          status: 409,
          headers: cors(request),
        });
      }
      try {
        await security.ensureHubConcept(id, spaceId);
        const now = new Date().toISOString();
        db.prepare(
          "INSERT INTO okf_concept (id, spaceId, title, type, intent, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
        ).run(id, spaceId, title, type, intent, now, now);
        const row = concept(id)!;
        const initial = id === CONCEPT && Object.keys(body).length === 0
          ? DEFAULT_MARKDOWN
          : `# ${title}\n`;
        await loadDocument(row, initial);
        await saveDraft(id, initial);
        security.audit(current.user.id, "concept.created", `concept:${id}`);
        return Response.json(await payload(row, true, current.user.id), {
          status: 201,
          headers: cors(request),
        });
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : "Creation failed",
        }, { status: 503, headers: cors(request) });
      }
    }

    const traceCollectionRoute = url.pathname.match(
      /^\/api\/concepts\/([^/]+)\/traces$/,
    );
    if (traceCollectionRoute && request.method === "POST") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      const conceptId = traceCollectionRoute[1];
      const row = concept(conceptId);
      if (
        !row || !await security.check(current.user.id, "edit", conceptId)
      ) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      if (row.status !== "active") {
        return Response.json({ error: "Restore the concept first" }, {
          status: 409,
          headers: cors(request),
        });
      }
      const body = await request.json().catch(() => ({})) as Record<
        string,
        unknown
      >;
      const kind = String(body.kind ?? "change") as WorkTraceKind;
      const title = String(body.title ?? "").trim();
      const summary = String(body.summary ?? "").trim();
      const occurredAt = String(body.occurredAt ?? "").trim();
      const sourceUrl = String(body.sourceUrl ?? "").trim();
      const occurredDate = new Date(`${occurredAt}T00:00:00Z`);
      if (
        !TRACE_KINDS.includes(kind) || !title || title.length > 100 ||
        !summary || summary.length > 4000 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(occurredAt) ||
        Number.isNaN(occurredDate.valueOf()) ||
        occurredDate.toISOString().slice(0, 10) !== occurredAt
      ) {
        return Response.json({ error: "Complete the trace fields" }, {
          status: 400,
          headers: cors(request),
        });
      }
      if (sourceUrl) {
        let parsed: URL;
        try {
          parsed = new URL(sourceUrl);
        } catch {
          return Response.json({ error: "Enter a valid HTTPS source link" }, {
            status: 400,
            headers: cors(request),
          });
        }
        if (
          parsed.protocol !== "https:" || parsed.username || parsed.password ||
          sourceUrl.length > 500
        ) {
          return Response.json({ error: "Enter a valid HTTPS source link" }, {
            status: 400,
            headers: cors(request),
          });
        }
      }
      const id = `trace-${crypto.randomUUID()}`;
      const createdAt = new Date().toISOString();
      db.prepare(
        "INSERT INTO okf_work_trace (id, conceptId, kind, title, summary, occurredAt, sourceUrl, actorUserId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        conceptId,
        kind,
        title,
        summary,
        occurredAt,
        sourceUrl,
        current.user.id,
        createdAt,
      );
      security.audit(current.user.id, "trace.created", `trace:${id}`);
      return Response.json(
        await payload(concept(conceptId)!, true, current.user.id),
        { status: 201, headers: cors(request) },
      );
    }

    const traceFoldRoute = url.pathname.match(
      /^\/api\/concepts\/([^/]+)\/traces\/(trace-[a-f0-9-]+)\/fold$/,
    );
    if (traceFoldRoute && request.method === "POST") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      const conceptId = traceFoldRoute[1];
      const trace = workTrace(traceFoldRoute[2]);
      if (
        !trace || trace.conceptId !== conceptId ||
        !await security.check(current.user.id, "edit", conceptId)
      ) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      if (trace.foldedAt) {
        return Response.json({ error: "Trace already folded" }, {
          status: 409,
          headers: cors(request),
        });
      }
      const body = await request.json().catch(() => ({})) as Record<
        string,
        unknown
      >;
      const targetConceptId = String(body.targetConceptId ?? "");
      const knowledge = String(body.knowledge ?? "").trim();
      const target = concept(targetConceptId);
      if (
        !target || target.status !== "active" ||
        target.intent !== "canonical" ||
        !await security.check(current.user.id, "edit", targetConceptId)
      ) {
        return Response.json(
          { error: "Choose an editable canonical document" },
          {
            status: 400,
            headers: cors(request),
          },
        );
      }
      if (!knowledge || knowledge.length > 10000) {
        return Response.json({ error: "Enter the lasting knowledge to fold" }, {
          status: 400,
          headers: cors(request),
        });
      }
      const targetDocument = await loadDocument(target);
      const baseMarkdown = targetConceptId === conceptId &&
          typeof body.targetMarkdown === "string"
        ? body.targetMarkdown
        : targetDocument.markdown;
      const sourceNote = trace.sourceUrl
        ? `> Folded from [${trace.kind} work](${trace.sourceUrl}) dated ${trace.occurredAt}.`
        : `> Folded from ${trace.kind} work dated ${trace.occurredAt}.`;
      const next =
        `${baseMarkdown.trimEnd()}\n\n## ${trace.title}\n\n${knowledge}\n\n${sourceNote}\n`;
      try {
        await saveDraft(targetConceptId, next);
      } catch (error) {
        const status = error instanceof MarkdownTooLarge ? 413 : 503;
        return Response.json({
          error: error instanceof Error ? error.message : "Fold failed",
        }, { status, headers: cors(request) });
      }
      const foldedAt = new Date().toISOString();
      db.prepare(
        "UPDATE okf_work_trace SET foldedIntoConceptId = ?, foldedAt = ?, foldedKnowledge = ? WHERE id = ? AND foldedAt IS NULL",
      ).run(targetConceptId, foldedAt, knowledge, trace.id);
      security.audit(current.user.id, "trace.folded", `trace:${trace.id}`);
      return Response.json(
        await payload(concept(conceptId)!, true, current.user.id),
        { headers: cors(request) },
      );
    }

    const conceptRoute = url.pathname.match(
      /^\/api\/concepts\/([^/]+)(?:\/(.+))?$/,
    );
    if (
      conceptRoute && request.method === "GET" && conceptRoute[2] === "export"
    ) {
      const current = await security.session(request);
      if (!current) {
        return new Response("Sign in required", {
          status: 401,
          headers: cors(request),
        });
      }
      const conceptId = conceptRoute[1];
      if (!await security.check(current.user.id, "view", conceptId)) {
        return new Response("Not found", {
          status: 404,
          headers: cors(request),
        });
      }
      const row = concept(conceptId);
      const canEdit = await security.check(current.user.id, "edit", conceptId);
      if (
        !row ||
        (!canEdit && (row.status === "archived" || !row.publishedRevision))
      ) {
        return new Response("Not found", {
          status: 404,
          headers: cors(request),
        });
      }
      if (!row.publishedRevision) {
        return new Response("Publish the document before exporting", {
          status: 409,
          headers: cors(request),
        });
      }
      const revision = revisions(conceptId).find((item) =>
        item.number === row.publishedRevision
      );
      if (!revision) {
        return new Response("Published revision not found", {
          status: 503,
          headers: cors(request),
        });
      }
      try {
        const markdown = await store.get(revision.objectKey);
        const headers = new Headers(cors(request));
        headers.set("content-type", "text/markdown; charset=utf-8");
        headers.set(
          "content-disposition",
          `attachment; filename="${conceptId}.md"`,
        );
        security.audit(
          current.user.id,
          "concept.exported",
          `concept:${conceptId}:revision:${row.publishedRevision}`,
        );
        return new Response(markdown, { headers });
      } catch (error) {
        return new Response(
          error instanceof Error ? error.message : "Export failed",
          { status: 503, headers: cors(request) },
        );
      }
    }
    if (conceptRoute && request.method === "GET" && !conceptRoute[2]) {
      const current = await security.session(request);
      if (!current) {
        return new Response("Sign in required", {
          status: 401,
          headers: cors(request),
        });
      }
      const conceptId = conceptRoute[1];
      if (!await security.check(current.user.id, "view", conceptId)) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      const row = concept(conceptId);
      const canEdit = await security.check(current.user.id, "edit", conceptId);
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
        return Response.json(await payload(row, canEdit, current.user.id), {
          headers: cors(request),
        });
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : "Storage unavailable",
        }, { status: 503, headers: cors(request) });
      }
    }
    if (
      conceptRoute && request.method === "PUT" &&
      conceptRoute[2] === "metadata"
    ) {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      const conceptId = conceptRoute[1];
      const row = concept(conceptId);
      if (
        !row || !await security.check(current.user.id, "edit", conceptId)
      ) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      const body = await request.json().catch(() => ({})) as Record<
        string,
        unknown
      >;
      const title = String(body.title ?? "").trim();
      const type = String(body.type ?? "").trim();
      const spaceId = String(body.spaceId ?? "");
      const intent = String(body.intent ?? row.intent) as DocumentIntent;
      if (
        !title || title.length > 100 ||
        !/^[A-Za-z][A-Za-z0-9 _-]{0,49}$/.test(type) ||
        !DOCUMENT_INTENTS.includes(intent)
      ) {
        return Response.json({
          error: "Title and type are required and must fit their fields",
        }, { status: 400, headers: cors(request) });
      }
      if (
        !space(spaceId) ||
        !await security.checkSpace(current.user.id, "edit", spaceId)
      ) {
        return Response.json({ error: "Destination space not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      try {
        await security.moveHubConcept(conceptId, row.spaceId, spaceId);
        db.prepare(
          "UPDATE okf_concept SET title = ?, type = ?, intent = ?, spaceId = ?, updatedAt = ? WHERE id = ?",
        ).run(
          title,
          type,
          intent,
          spaceId,
          new Date().toISOString(),
          conceptId,
        );
        if (row.spaceId !== spaceId) {
          (await loadDocument(row)).clients.forEach((client) =>
            client.close(1000, "Concept moved")
          );
        }
        security.audit(
          current.user.id,
          "concept.updated",
          `concept:${conceptId}`,
        );
        return Response.json(
          await payload(concept(conceptId)!, true, current.user.id),
          {
            headers: cors(request),
          },
        );
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : "Update failed",
        }, { status: 503, headers: cors(request) });
      }
    }
    if (conceptRoute && request.method === "PUT" && !conceptRoute[2]) {
      const current = await security.session(request);
      if (!current) {
        return new Response("Sign in required", {
          status: 401,
          headers: cors(request),
        });
      }
      const conceptId = conceptRoute[1];
      if (!await security.check(current.user.id, "view", conceptId)) {
        return new Response("Not found", {
          status: 404,
          headers: cors(request),
        });
      }
      if (!await security.check(current.user.id, "edit", conceptId)) {
        return new Response("Edit access required", {
          status: 403,
          headers: cors(request),
        });
      }
      const row = concept(conceptId);
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
        await saveDraft(conceptId, await request.text());
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
    if (conceptRoute && request.method === "POST" && conceptRoute[2]) {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      const conceptId = conceptRoute[1];
      const action = conceptRoute[2];
      if (!await security.check(current.user.id, "view", conceptId)) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      if (!await security.check(current.user.id, "edit", conceptId)) {
        return Response.json({ error: "Edit access required" }, {
          status: 403,
          headers: cors(request),
        });
      }
      const row = concept(conceptId);
      if (!row) {
        return Response.json({ error: "Not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      try {
        if (action === "publish") {
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
          const live = await loadDocument(row);
          await saveDraft(
            conceptId,
            typeof body.markdown === "string" ? body.markdown : live.markdown,
          );
          // ponytail: one process allocates revision numbers; use a DB sequence if multi-node publishing arrives.
          const number = Number(
            (db.prepare(
              "SELECT COALESCE(MAX(number), 0) + 1 AS number FROM okf_revision WHERE conceptId = ?",
            ).get(conceptId) as { number: number }).number,
          );
          const publishedAt = new Date().toISOString();
          const objectKey = `${encodeURIComponent(row.spaceId)}/${
            encodeURIComponent(conceptId)
          }/revisions/${number}.md`;
          await store.put(
            objectKey,
            publishedMarkdown(
              live.markdown,
              current.user.id,
              publishedAt,
              row.title,
              row.type,
            ),
          );
          db.exec("BEGIN");
          try {
            db.prepare(
              "INSERT INTO okf_revision (conceptId, number, objectKey, publishedAt, actorUserId) VALUES (?, ?, ?, ?, ?)",
            ).run(conceptId, number, objectKey, publishedAt, current.user.id);
            db.prepare(
              "UPDATE okf_concept SET publishedRevision = ?, updatedAt = ? WHERE id = ?",
            ).run(number, publishedAt, conceptId);
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          return Response.json(
            await payload(concept(conceptId)!, true, current.user.id),
            {
              headers: cors(request),
            },
          );
        }
        if (action === "archive") {
          db.prepare(
            "UPDATE okf_concept SET status = 'archived', updatedAt = ? WHERE id = ?",
          ).run(new Date().toISOString(), conceptId);
          (await loadDocument(row)).clients.forEach((client) =>
            client.close(1000, "Concept archived")
          );
          return Response.json(
            await payload(concept(conceptId)!, true, current.user.id),
            {
              headers: cors(request),
            },
          );
        }
        if (action === "restore") {
          db.prepare(
            "UPDATE okf_concept SET status = 'active', updatedAt = ? WHERE id = ?",
          ).run(new Date().toISOString(), conceptId);
          return Response.json(
            await payload(concept(conceptId)!, true, current.user.id),
            {
              headers: cors(request),
            },
          );
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
          ).get(conceptId, Number(revision[1])) as
            | { objectKey: string }
            | undefined;
          if (!item) {
            return Response.json({ error: "Revision not found" }, {
              status: 404,
              headers: cors(request),
            });
          }
          await saveDraft(conceptId, bodyOnly(await store.get(item.objectKey)));
          return Response.json(
            await payload(concept(conceptId)!, true, current.user.id),
            {
              headers: cors(request),
            },
          );
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
      const conceptId = url.searchParams.get("conceptId") ?? CONCEPT;
      if (!await security.check(current.user.id, "view", conceptId)) {
        return new Response("Not found", { status: 404 });
      }
      const canEdit = await security.check(current.user.id, "edit", conceptId);
      if (!canEdit) {
        return new Response("Edit access required", { status: 403 });
      }
      const row = concept(conceptId);
      if (row?.status !== "active") {
        return new Response("Concept unavailable", { status: 409 });
      }
      const live = await loadDocument(row);
      const { socket, response } = Deno.upgradeWebSocket(request);
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () => {
        live.clients.add(socket);
        socket.send(frame(DOCUMENT_UPDATE, Y.encodeStateAsUpdate(live.doc)));
        socket.send("synced");
      });
      socket.addEventListener("message", async (event) => {
        if (typeof event.data === "string") return;
        const message = await bytes(event.data);
        if (!message?.length) return;
        if (message[0] === DOCUMENT_UPDATE && canEdit) {
          Y.applyUpdate(live.doc, message.subarray(1), socket);
        }
        if (message[0] !== DOCUMENT_UPDATE && message[0] !== AWARENESS_UPDATE) {
          return;
        }
        for (const client of live.clients) {
          if (client !== socket && client.readyState === WebSocket.OPEN) {
            client.send(message.slice().buffer as ArrayBuffer);
          }
        }
      });
      socket.addEventListener("close", () => live.clients.delete(socket));
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
      if (automationTimer !== undefined) clearInterval(automationTimer);
      await activeAutomation;
      for (const live of documents.values()) {
        live.clients.forEach((client) => client.close());
        await live.stateWrite;
        live.doc.destroy();
      }
      db.close();
      security.close();
    },
  };
}

if (import.meta.main) {
  const hostname = Deno.env.get("OKF_HOST") ?? "127.0.0.1";
  const port = Number(Deno.env.get("OKF_PORT") ?? "8788");
  const automationIntervalMs = Number(
    Deno.env.get("OKF_AUTOMATION_INTERVAL_MS") ??
      DEFAULT_AUTOMATION_INTERVAL_MS,
  );
  const allowedArtifactHosts =
    (Deno.env.get("OKF_ARTIFACT_ALLOWED_HOSTS") ?? "")
      .split(",").map((host) => host.trim()).filter(Boolean);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OKF_PORT must be a valid TCP port");
  }
  if (!Number.isFinite(automationIntervalMs) || automationIntervalMs < 0) {
    throw new Error("OKF_AUTOMATION_INTERVAL_MS must be zero or greater");
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
    automationIntervalMs,
    allowedArtifactHosts,
  });
  Deno.serve({ hostname, port }, app.fetch);
}

/// <reference lib="deno.ns" />

import * as Y from "yjs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, normalize } from "node:path/posix";
import { type AIRequest, type AIResponder, createAIResponder } from "./ai.ts";
import {
  actionAllowed,
  ActionError,
  createActionCatalog,
} from "./action-catalog.ts";
import { ArtifactInputError, createArtifactStore } from "./artifact-store.ts";
import { createConnectorRegistry } from "./connector-registry.ts";
import { createCredentialVault } from "./credential-vault.ts";
import {
  createZip,
  ExportArchiveError,
  type ExportFile,
} from "./export-archive.ts";
import { createGitHubAppClient, type GitHubAppClient } from "./github-app.ts";
import { createObjectStore } from "./object-store.ts";
import { type NotionSourceConfig, syncNotionSource } from "./notion-source.ts";
import {
  inspectOkf,
  type RepositoryCredentials,
  type RepositorySnapshot,
  syncRepository,
} from "./repository-source.ts";
import { CONCEPT, createSecurity } from "./security.ts";
import { type SharedSourceConfig, syncSharedSource } from "./shared-source.ts";
import { type ConfiguredSSOProvider, parseSSOConfig } from "./sso-config.ts";

const DOCUMENT_UPDATE = 0;
const AWARENESS_UPDATE = 1;
const MAX_MARKDOWN_BYTES = 512 * 1024;
const DEFAULT_AUTOMATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SOURCE_AUTOMATION_INTERVALS = [0, 60, 360, 720, 1440, 10080];
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
class DocumentLocked extends Error {}

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

const UNDERSTANDING_BRIEF_TEMPLATE: TemplateRow = {
  id: "understanding-brief",
  name: "Understanding brief",
  description:
    "Explain a meaningful change so people can participate, not just approve it.",
  body: `## Background

Describe what existed before this work. Link the canonical concepts a reader should know.

## Goal

State the human outcome before implementation details.

## Mental model

Explain the system behavior in plain language. Add a diagram or governed App only when interaction makes it clearer.

## Change walkthrough

Walk through the change in dependency order, not file-name order.

## Invariants and trade-offs

- Preserved:
- Chosen:
- Rejected:

## Evidence and unknowns

- Verified:
- Still unknown:

## Check your understanding

1. What was the previous behavior?
2. Why was this approach chosen?
3. Which invariant would reveal a regression?
`,
  variables: "[]",
  createdBy: "system",
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
};

type AppOptions = {
  dataDir?: string;
  staticDir?: string;
  baseURL?: string;
  trustedOrigins?: string[];
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
  notionSourceSync?: (
    config: NotionSourceConfig,
  ) => Promise<RepositorySnapshot>;
  automationIntervalMs?: number;
  allowedArtifactHosts?: string[];
  githubApp?: GitHubAppClient | null;
  ssoProviders?: ConfiguredSSOProvider[];
  aiProvider?: string;
  aiModel?: string;
  aiURL?: string;
  aiAPIKey?: string;
  aiResponder?: AIResponder;
};

type ConceptRow = {
  id: string;
  spaceId: string;
  parentId: string | null;
  sortOrder: number;
  collabEpoch: number;
  title: string;
  type: string;
  intent: DocumentIntent;
  status: "active" | "archived";
  publishedRevision: number | null;
  lockedAt: string | null;
  lockedBy: string | null;
  updatedAt: string;
};

type CommentThreadRow = {
  id: string;
  conceptId: string;
  anchorText: string;
  anchorStart: number | null;
  anchorEnd: number | null;
  revisionNumber: number | null;
  createdBy: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
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
  icon: string;
  createdAt: string;
};

type TemplateRow = {
  id: string;
  name: string;
  description: string;
  body: string;
  variables: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
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
  githubInstallationId: number | null;
  githubRepositoryId: number | null;
  githubFullName: string | null;
  automationIntervalMinutes: number;
};

type SourceSyncRow = {
  id: number;
  sourceId: string;
  trigger: "connect" | "manual" | "webhook" | "scheduled";
  status: "running" | "succeeded" | "failed";
  revision: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};

type SharedSourceRow = {
  id: "shared";
  endpoint: string;
  bucket: string;
  path: string;
  region: string;
  credentialsCipher: string;
  status: "syncing" | "current" | "sync_failed";
  revision: string | null;
  lastSyncedAt: string | null;
  error: string | null;
  automationIntervalMinutes: number;
};

type NotionSourceRow = {
  id: "notion";
  credentialsCipher: string;
  status: "syncing" | "current" | "sync_failed";
  revision: string | null;
  lastSyncedAt: string | null;
  error: string | null;
  automationIntervalMinutes: number;
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
  if (match?.[1].match(/^[A-Za-z][A-Za-z0-9_-]*\s*:/m)) {
    return markdown.slice(match[0].length);
  }
  const renderedTitle = markdown.match(
    /^\*\*\*\r?\n(?:\r?\n)?##\s+title:\s*["'][^\r\n]*["']\r?\n(?:\r?\n)?/,
  );
  return renderedTitle ? markdown.slice(renderedTitle[0].length) : markdown;
}

function archiveSegment(value: string, fallback: string) {
  const portable = Array.from(value.normalize("NFKC"), (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? "-" : character;
  }).join("");
  const clean = portable
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return Array.from(clean || fallback).slice(0, 60).join("");
}

function markdownLabel(value: string) {
  return value.replace(/[\\[\]]/g, "\\$&").replace(/\r?\n/g, " ");
}

function uniqueArchiveNames(
  items: { id: string; label: string }[],
) {
  const bases = new Map(
    items.map((item) => [item.id, archiveSegment(item.label, item.id)]),
  );
  const counts = new Map<string, number>();
  for (const base of bases.values()) {
    const key = base.toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Map(
    items.map((item) => {
      const base = bases.get(item.id)!;
      return [
        item.id,
        counts.get(base.toLocaleLowerCase()) === 1
          ? base
          : `${base} (${archiveSegment(item.id, "item").slice(0, 12)})`,
      ];
    }),
  );
}

function withoutFrontmatter(markdown: string) {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)?/);
  return match ? markdown.slice(match[0].length) : markdown;
}

function markdownHrefs(markdown: string) {
  return Array.from(
    markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g),
  )
    .map((match) => match[1]);
}

function templateVariables(markdown: string) {
  return Array.from(
    new Set(
      Array.from(markdown.matchAll(/{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g))
        .map((match) => match[1]),
    ),
  );
}

function renderTemplate(
  markdown: string,
  values: Record<string, unknown>,
): { error: string } | { body: string } {
  const missing = templateVariables(markdown).filter((name) =>
    !Object.hasOwn(values, name) || typeof values[name] !== "string"
  );
  if (missing.length) return { error: `Fill in ${missing.join(", ")}` };
  const body = markdown.replace(
    /{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g,
    (_match, name: string) => String(values[name]),
  );
  return { body };
}

function searchSnippet(
  text: string,
  query: string,
  title: string,
  metadata: string[],
) {
  let body = text;
  for (const value of [title, ...metadata].filter(Boolean)) {
    if (body.startsWith(`${value}\n`)) body = body.slice(value.length + 1);
  }
  let plain = body.replace(/[`*_>#|[\]()~-]/g, " ").replace(/\s+/g, " ")
    .trim();
  if (plain.toLocaleLowerCase().startsWith(title.toLocaleLowerCase())) {
    plain = plain.slice(title.length).replace(/^[:\s-]+/, "");
  }
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
  let portless = false;
  try {
    const url = new URL(origin ?? "");
    portless = ["http:", "https:"].includes(url.protocol) &&
      (url.hostname === "okf-hub.localhost" ||
        url.hostname.endsWith(".okf-hub.localhost"));
  } catch {
    // Invalid Origin headers are rejected below.
  }
  return !origin || origin === new URL(request.url).origin ||
    portless ||
    ["http://localhost:3000", "http://127.0.0.1:3000"].includes(origin);
}

function cors(request: Request) {
  return {
    "access-control-allow-origin": request.headers.get("origin") ?? "*",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
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
  trustedOrigins,
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
  notionSourceSync = syncNotionSource,
  automationIntervalMs = DEFAULT_AUTOMATION_INTERVAL_MS,
  allowedArtifactHosts = [],
  githubApp = null,
  ssoProviders = [],
  aiProvider = "",
  aiModel = "",
  aiURL = "https://ollama.com/v1",
  aiAPIKey,
  aiResponder,
}: AppOptions = {}) {
  await Deno.mkdir(dataDir, { recursive: true });
  const security = await createSecurity({
    dataDir,
    baseURL,
    trustedOrigins,
    authSecret,
    openfgaURL,
    openfgaKey,
    ssoProviders,
  });
  const db = new DatabaseSync(`${dataDir}/hub.db`);
  const credentialVault = await createCredentialVault(dataDir);
  const respondWithAI = aiResponder ??
    (aiProvider && aiModel
      ? createAIResponder({
        provider: aiProvider,
        model: aiModel,
        apiURL: aiURL,
        apiKey: aiAPIKey,
      })
      : null);
  const defaultAutomationIntervalMinutes = automationIntervalMs > 0
    ? Math.max(1, Math.round(automationIntervalMs / 60_000))
    : 0;
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS okf_space (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS okf_concept (
      id TEXT PRIMARY KEY,
      spaceId TEXT NOT NULL DEFAULT 'policies',
      parentId TEXT,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      collabEpoch INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      intent TEXT NOT NULL DEFAULT 'canonical' CHECK (intent IN ('canonical', 'working', 'evidence', 'ephemeral')),
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      publishedRevision INTEGER,
      lockedAt TEXT,
      lockedBy TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (spaceId) REFERENCES okf_space(id),
      FOREIGN KEY (parentId) REFERENCES okf_concept(id)
    );
    CREATE TABLE IF NOT EXISTS okf_comment_thread (
      id TEXT PRIMARY KEY,
      conceptId TEXT NOT NULL,
      anchorText TEXT NOT NULL DEFAULT '',
      anchorStart INTEGER,
      anchorEnd INTEGER,
      revisionNumber INTEGER,
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      resolvedAt TEXT,
      resolvedBy TEXT,
      FOREIGN KEY (conceptId) REFERENCES okf_concept(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS okf_comment (
      id TEXT PRIMARY KEY,
      threadId TEXT NOT NULL,
      authorId TEXT NOT NULL,
      body TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      deletedAt TEXT,
      FOREIGN KEY (threadId) REFERENCES okf_comment_thread(id) ON DELETE CASCADE
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
    CREATE TABLE IF NOT EXISTS okf_template (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      variables TEXT NOT NULL DEFAULT '[]',
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS okf_repository_source (
      id TEXT PRIMARY KEY,
      repositoryUrl TEXT NOT NULL,
      folder TEXT NOT NULL,
      credentialsCipher TEXT,
      status TEXT NOT NULL CHECK (status IN ('syncing', 'current', 'sync_failed')),
      revision TEXT,
      lastSyncedAt TEXT,
      error TEXT,
      githubInstallationId INTEGER,
      githubRepositoryId INTEGER,
      githubFullName TEXT,
      automationIntervalMinutes INTEGER NOT NULL DEFAULT 360
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
      error TEXT,
      automationIntervalMinutes INTEGER NOT NULL DEFAULT 360
    );
    CREATE TABLE IF NOT EXISTS okf_notion_source (
      id TEXT PRIMARY KEY CHECK (id = 'notion'),
      credentialsCipher TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('syncing', 'current', 'sync_failed')),
      revision TEXT,
      lastSyncedAt TEXT,
      error TEXT,
      automationIntervalMinutes INTEGER NOT NULL DEFAULT 360
    );
    CREATE TABLE IF NOT EXISTS okf_connector_setting (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
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
    CREATE TABLE IF NOT EXISTS okf_source_sync (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sourceId TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK (trigger IN ('connect', 'manual', 'webhook', 'scheduled')),
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
      revision TEXT,
      startedAt TEXT NOT NULL,
      finishedAt TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS okf_github_delivery (
      deliveryId TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      receivedAt TEXT NOT NULL
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
  const spaceColumns = db.prepare("PRAGMA table_info(okf_space)").all() as {
    name: string;
  }[];
  if (!spaceColumns.some(({ name }) => name === "icon")) {
    db.exec("ALTER TABLE okf_space ADD COLUMN icon TEXT NOT NULL DEFAULT ''");
  }
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
  if (!conceptColumns.some(({ name }) => name === "parentId")) {
    db.exec(
      "ALTER TABLE okf_concept ADD COLUMN parentId TEXT REFERENCES okf_concept(id)",
    );
  }
  if (!conceptColumns.some(({ name }) => name === "sortOrder")) {
    db.exec(
      "ALTER TABLE okf_concept ADD COLUMN sortOrder INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!conceptColumns.some(({ name }) => name === "collabEpoch")) {
    db.exec(
      "ALTER TABLE okf_concept ADD COLUMN collabEpoch INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!conceptColumns.some(({ name }) => name === "lockedAt")) {
    db.exec("ALTER TABLE okf_concept ADD COLUMN lockedAt TEXT");
  }
  if (!conceptColumns.some(({ name }) => name === "lockedBy")) {
    db.exec("ALTER TABLE okf_concept ADD COLUMN lockedBy TEXT");
  }
  const repositoryColumns = db.prepare(
    "PRAGMA table_info(okf_repository_source)",
  ).all() as { name: string }[];
  if (!repositoryColumns.some(({ name }) => name === "credentialsCipher")) {
    db.exec(
      "ALTER TABLE okf_repository_source ADD COLUMN credentialsCipher TEXT",
    );
  }
  for (
    const [name, type] of [
      ["githubInstallationId", "INTEGER"],
      ["githubRepositoryId", "INTEGER"],
      ["githubFullName", "TEXT"],
      ["automationIntervalMinutes", "INTEGER NOT NULL DEFAULT 360"],
    ]
  ) {
    if (!repositoryColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE okf_repository_source ADD COLUMN ${name} ${type}`);
    }
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
        error TEXT,
        githubInstallationId INTEGER,
        githubRepositoryId INTEGER,
        githubFullName TEXT,
        automationIntervalMinutes INTEGER NOT NULL DEFAULT 360
      );
      INSERT INTO okf_repository_source
        (id, repositoryUrl, folder, credentialsCipher, status, revision, lastSyncedAt, error)
        SELECT id, repositoryUrl, folder, credentialsCipher, status, revision, lastSyncedAt, error
        FROM okf_repository_source_legacy;
      DROP TABLE okf_repository_source_legacy;
      COMMIT;
    `);
  }
  const sharedSourceColumns = db.prepare(
    "PRAGMA table_info(okf_shared_source)",
  ).all() as { name: string }[];
  if (
    !sharedSourceColumns.some(({ name }) =>
      name === "automationIntervalMinutes"
    )
  ) {
    db.exec(
      "ALTER TABLE okf_shared_source ADD COLUMN automationIntervalMinutes INTEGER NOT NULL DEFAULT 360",
    );
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
  db.exec(`
    UPDATE okf_imported_concept
    SET importedAt = (
      SELECT importedAt FROM okf_imported_revision
      WHERE conceptId = okf_imported_concept.id
        AND sourceRevision = okf_imported_concept.sourceRevision
    )
    WHERE EXISTS (
      SELECT 1 FROM okf_imported_revision
      WHERE conceptId = okf_imported_concept.id
        AND sourceRevision = okf_imported_concept.sourceRevision
        AND importedAt < okf_imported_concept.importedAt
    )
  `);
  const artifactStore = createArtifactStore(db, allowedArtifactHosts);
  const connectors = createConnectorRegistry({
    git: repositorySync,
    s3: sharedSourceSync,
    notion: notionSourceSync,
  });
  for (const connector of connectors.definitions) {
    db.prepare(
      "INSERT OR IGNORE INTO okf_connector_setting (id, enabled) VALUES (?, ?)",
    ).run(connector.id, connector.enabledByDefault ? 1 : 0);
  }
  const connectorEnabled = (id: string) =>
    Boolean(
      (db.prepare(
        "SELECT enabled FROM okf_connector_setting WHERE id = ?",
      ).get(id) as { enabled?: number } | undefined)?.enabled,
    );
  const connectorPayloads = () =>
    connectors.definitions.map((connector) => ({
      ...connector,
      enabled: connectorEnabled(connector.id),
    }));
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
    db.prepare(
      "SELECT * FROM okf_concept ORDER BY spaceId, COALESCE(parentId, ''), sortOrder, createdAt",
    )
      .all() as ConceptRow[];
  const nextSortOrder = (spaceId: string, parentId: string | null) =>
    Number(
      (db.prepare(
        "SELECT COALESCE(MAX(sortOrder), -1) + 1 AS value FROM okf_concept WHERE spaceId = ? AND parentId IS ?",
      ).get(spaceId, parentId) as { value: number }).value,
    );
  const openCommentCount = (conceptId: string) =>
    Number(
      (db.prepare(
        "SELECT COUNT(*) AS value FROM okf_comment_thread WHERE conceptId = ? AND resolvedAt IS NULL",
      ).get(conceptId) as { value: number }).value,
    );
  const commentThreads = (
    conceptId: string,
    status: "open" | "resolved",
  ) => {
    const rows = db.prepare(
      `SELECT * FROM okf_comment_thread
       WHERE conceptId = ? AND resolvedAt IS ${
        status === "open" ? "NULL" : "NOT NULL"
      }
       ORDER BY createdAt DESC`,
    ).all(conceptId) as CommentThreadRow[];
    const messages = db.prepare(
      `SELECT c.id, c.threadId, c.authorId, c.body, c.createdAt, c.updatedAt,
              u.name AS authorName, u.email AS authorEmail
       FROM okf_comment c LEFT JOIN user u ON u.id = c.authorId
       WHERE c.threadId = ? AND c.deletedAt IS NULL ORDER BY c.createdAt`,
    );
    return rows.map((thread) => ({
      ...thread,
      comments: messages.all(thread.id),
    }));
  };
  const invalidParent = (conceptId: string, parentId: string | null) => {
    const seen = new Set([conceptId]);
    let current = parentId;
    while (current) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = concept(current)?.parentId ?? null;
    }
    return false;
  };
  const space = (id: string) =>
    db.prepare("SELECT * FROM okf_space WHERE id = ?").get(id) as
      | SpaceRow
      | undefined;
  const spaces = () =>
    db.prepare("SELECT * FROM okf_space ORDER BY name").all() as SpaceRow[];
  const templates = () => [
    UNDERSTANDING_BRIEF_TEMPLATE,
    ...db.prepare("SELECT * FROM okf_template ORDER BY name")
      .all() as TemplateRow[],
  ];
  const template = (id: string) =>
    id === UNDERSTANDING_BRIEF_TEMPLATE.id
      ? UNDERSTANDING_BRIEF_TEMPLATE
      : db.prepare("SELECT * FROM okf_template WHERE id = ?").get(id) as
        | TemplateRow
        | undefined;
  const templatePayload = (item: TemplateRow) => ({
    ...item,
    variables: JSON.parse(item.variables) as string[],
    builtIn: item.id === UNDERSTANDING_BRIEF_TEMPLATE.id,
  });
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
  const sourceSyncs = (sourceId: string) =>
    db.prepare(
      "SELECT id, sourceId, trigger, status, revision, startedAt, finishedAt, error FROM okf_source_sync WHERE sourceId = ? ORDER BY id DESC LIMIT 10",
    ).all(sourceId) as SourceSyncRow[];
  const sharedSource = () =>
    db.prepare("SELECT * FROM okf_shared_source WHERE id = 'shared'").get() as
      | SharedSourceRow
      | undefined;
  const notionSource = () =>
    db.prepare("SELECT * FROM okf_notion_source WHERE id = 'notion'").get() as
      | NotionSourceRow
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
      : sourceId === "notion"
      ? notionSource()
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
      syncs: sourceSyncs(sourceId),
      automationIntervalMinutes: source.automationIntervalMinutes,
    };
    return sourceId === "notion"
      ? {
        ...common,
        kind: "notion",
        credentialsConfigured: true,
      }
      : sourceId !== "shared"
      ? {
        ...common,
        kind: (source as RepositorySourceRow).githubInstallationId
          ? "github"
          : "git",
        repositoryUrl: (source as RepositorySourceRow).repositoryUrl,
        folder: (source as RepositorySourceRow).folder,
        githubFullName: (source as RepositorySourceRow).githubFullName,
        credentialsConfigured: Boolean(
          (source as RepositorySourceRow).credentialsCipher ||
            (source as RepositorySourceRow).githubInstallationId,
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
            "importedAt = CASE WHEN okf_imported_concept.contentHash = excluded.contentHash THEN okf_imported_concept.importedAt ELSE excluded.importedAt END, " +
            "contentHash = excluded.contentHash, nextPath = NULL, " +
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

  async function syncRepositorySource(
    sourceId: string,
    trigger: SourceSyncRow["trigger"],
  ) {
    if (!connectorEnabled("git")) throw new Error("Git connector is disabled");
    const source = repositorySource(sourceId);
    if (!source) throw new Error("Connect a repository first");
    const syncId = Number(
      db.prepare(
        "INSERT INTO okf_source_sync (sourceId, trigger, status, startedAt) VALUES (?, ?, 'running', ?)",
      ).run(sourceId, trigger, new Date().toISOString()).lastInsertRowid,
    );
    db.prepare(
      "UPDATE okf_repository_source SET status = 'syncing', error = NULL WHERE id = ?",
    ).run(sourceId);
    try {
      const credentials = source.githubInstallationId
        ? await githubApp?.credentials(source.githubInstallationId)
        : source.credentialsCipher
        ? await credentialVault.decrypt<RepositoryCredentials>(
          source.credentialsCipher,
        )
        : undefined;
      if (source.githubInstallationId && !credentials) {
        throw new Error("GitHub App is not configured");
      }
      const snapshot = await connectors.sync({
        kind: "git",
        checkout: `${dataDir}/sources/${sourceId}`,
        repositoryUrl: source.repositoryUrl,
        folder: source.folder,
        credentials,
      });
      await importSnapshot(sourceId, snapshot, (revision, now) => {
        db.prepare(
          "UPDATE okf_repository_source SET status = 'current', revision = ?, lastSyncedAt = ?, error = NULL WHERE id = ?",
        ).run(revision, now, sourceId);
      });
      db.prepare(
        "UPDATE okf_source_sync SET status = 'succeeded', revision = ?, finishedAt = ? WHERE id = ?",
      ).run(snapshot.revision, new Date().toISOString(), syncId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed";
      db.prepare(
        "UPDATE okf_repository_source SET status = 'sync_failed', error = ? WHERE id = ?",
      ).run(message.slice(0, 500), sourceId);
      db.prepare(
        "UPDATE okf_source_sync SET status = 'failed', error = ?, finishedAt = ? WHERE id = ?",
      ).run(message.slice(0, 500), new Date().toISOString(), syncId);
      throw error;
    }
  }

  const repositoryRefreshes = new Map<string, Promise<void>>();
  function refreshRepository(
    sourceId: string,
    trigger: SourceSyncRow["trigger"] = "manual",
  ) {
    const active = repositoryRefreshes.get(sourceId);
    if (active) return active;
    const refresh = syncRepositorySource(sourceId, trigger).finally(() => {
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
    if (!connectorEnabled("s3")) throw new Error("S3 connector is disabled");
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
      const snapshot = await connectors.sync({
        kind: "s3",
        config: {
          endpoint: source.endpoint,
          bucket: source.bucket,
          path: source.path,
          region: source.region,
          ...credentials,
        },
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

  async function syncNotionWorkspace() {
    if (!connectorEnabled("notion")) {
      throw new Error("Notion connector is disabled");
    }
    const source = notionSource();
    if (!source) throw new Error("Connect Notion first");
    db.prepare(
      "UPDATE okf_notion_source SET status = 'syncing', error = NULL WHERE id = 'notion'",
    ).run();
    try {
      const credentials = await credentialVault.decrypt<NotionSourceConfig>(
        source.credentialsCipher,
      );
      const snapshot = await connectors.sync({
        kind: "notion",
        config: credentials,
      });
      await importSnapshot("notion", snapshot, (revision, now) => {
        db.prepare(
          "UPDATE okf_notion_source SET status = 'current', revision = ?, lastSyncedAt = ?, error = NULL WHERE id = 'notion'",
        ).run(revision, now);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed";
      db.prepare(
        "UPDATE okf_notion_source SET status = 'sync_failed', error = ? WHERE id = 'notion'",
      ).run(message.slice(0, 500));
      throw error;
    }
  }

  let notionRefresh: Promise<void> | undefined;
  function refreshNotion() {
    if (notionRefresh) return notionRefresh;
    notionRefresh = syncNotionWorkspace().finally(() => {
      notionRefresh = undefined;
    });
    return notionRefresh;
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
        await (sourceId === "shared"
          ? refreshSharedStore()
          : sourceId === "notion"
          ? refreshNotion()
          : refreshRepository(sourceId, "scheduled"));
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

  async function checkBrokenLinks(
    runId: number,
    actorUserId: string,
    sourceIds?: Set<string>,
  ) {
    const startedAt = new Date().toISOString();
    const id = Number(
      db.prepare(
        "INSERT INTO okf_automation_attempt (runId, job, attempt, status, startedAt) VALUES (?, 'broken_links', 1, 'running', ?)",
      ).run(runId, startedAt).lastInsertRowid,
    );
    try {
      const visible = [];
      for (const item of importedConcepts()) {
        if (sourceIds && !sourceIds.has(item.sourceId)) continue;
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
    requestedSourceIds?: string[],
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
        const sourceIds = requestedSourceIds ?? [
          ...repositorySources().map((source) => source.id),
          ...(sharedSource() ? ["shared"] : []),
          ...(notionSource() ? ["notion"] : []),
        ];
        for (const sourceId of sourceIds) {
          jobs.push(checkSource(runId, sourceId));
        }
        jobs.push(checkBrokenLinks(runId, actorUserId, new Set(sourceIds)));
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

  const latestSourceAttempt = db.prepare(
    "SELECT startedAt, finishedAt FROM okf_automation_attempt WHERE job = 'source_check' AND sourceId = ? ORDER BY id DESC LIMIT 1",
  );
  function scheduledSourceIds(now = Date.now()) {
    const sources = [
      ...repositorySources(),
      ...(sharedSource() ? [sharedSource()!] : []),
      ...(notionSource() ? [notionSource()!] : []),
    ];
    return sources.filter((source) => {
      if (source.automationIntervalMinutes <= 0) return false;
      const previous = latestSourceAttempt.get(source.id) as
        | { startedAt: string; finishedAt: string | null }
        | undefined;
      if (!previous) return true;
      const lastRun = Date.parse(previous.finishedAt ?? previous.startedAt);
      return !Number.isFinite(lastRun) ||
        now - lastRun >= source.automationIntervalMinutes * 60_000;
    }).map((source) => source.id);
  }

  const automationTimer = automationIntervalMs > 0
    ? setInterval(() => {
      const owner = automationOwner();
      const due = scheduledSourceIds();
      const run = owner && due.length
        ? startAutomation("scheduled", owner, due)
        : null;
      if (run) {
        void run.catch((error) =>
          console.error("Scheduled source checks failed", error)
        );
      }
    }, Math.min(automationIntervalMs, 60_000))
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
      markdown = fallback ?? "";
    }
    const cleanMarkdown = bodyOnly(markdown);
    if (cleanMarkdown !== markdown) {
      markdown = `${cleanMarkdown.trimEnd()}\n`;
      await Deno.writeTextFile(markdownPath(row.id), markdown);
      await Deno.remove(statePath(row.id)).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
      db.prepare(
        "UPDATE okf_concept SET collabEpoch = collabEpoch + 1 WHERE id = ?",
      ).run(row.id);
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
    if (row.lockedAt) {
      throw new DocumentLocked("Unlock the document to edit it");
    }
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
      openCommentCount: openCommentCount(row.id),
      space: space(row.spaceId)?.name ?? row.spaceId,
      draft: canEdit ? live.markdown : null,
      published: published ? bodyOnly(published) : null,
      revisions: canEdit ? history : [],
      activity: security.activity(`concept:${row.id}`),
      workTraces: canEdit
        ? traces
        : traces.map((trace) => ({ ...trace, foldedKnowledge: null })),
    };
  }

  async function portableArchive(userId: string, selectedSpaces: SpaceRow[]) {
    const spaceIds = new Set(selectedSpaces.map((item) => item.id));
    const rows: ConceptRow[] = [];
    for (const row of concepts()) {
      if (
        spaceIds.has(row.spaceId) &&
        await security.check(userId, "edit", row.id)
      ) rows.push(row);
    }
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const parentById = new Map(
      rows.map((row) => [
        row.id,
        row.parentId && rowById.has(row.parentId) ? row.parentId : null,
      ]),
    );
    const spaceNames = uniqueArchiveNames(
      selectedSpaces.map((item) => ({ id: item.id, label: item.name })),
    );
    const documentNames = new Map<string, string>();
    const siblingGroups = new Map<string, ConceptRow[]>();
    for (const row of rows) {
      const key = `${row.spaceId}\0${parentById.get(row.id) ?? ""}`;
      siblingGroups.set(key, [...(siblingGroups.get(key) ?? []), row]);
    }
    for (const siblings of siblingGroups.values()) {
      const names = uniqueArchiveNames(siblings.map((row) => ({
        id: row.id,
        label: `${row.title}${row.status === "archived" ? " (archived)" : ""}`,
      })));
      for (const [id, name] of names) documentNames.set(id, name);
    }
    const files: ExportFile[] = [{
      path: "okf/index.md",
      body: `---\nokf_version: "0.2"\n---\n\n# Spaces\n\n${
        selectedSpaces.map((item) =>
          `* [${markdownLabel(item.name)}](<${spaceNames.get(
            item.id,
          )!}/>) - Documents exported from this space.`
        ).join("\n")
      }\n`,
    }];
    for (const selectedSpace of selectedSpaces) {
      const entries = rows.filter((row) => row.spaceId === selectedSpace.id)
        .map((row) => {
          const chain: string[] = [];
          const seen = new Set<string>();
          let current: ConceptRow | undefined = row;
          while (current && !seen.has(current.id)) {
            seen.add(current.id);
            chain.unshift(
              `${documentNames.get(current.id)!}${
                current === row ? ".md" : ""
              }`,
            );
            current = rowById.get(parentById.get(current.id) ?? "");
          }
          return `* [${markdownLabel(row.title)}](<${
            chain.join("/")
          }>) - ${row.type}`;
        });
      files.push({
        path: `okf/${spaceNames.get(selectedSpace.id)!}/index.md`,
        body: `# Documents\n\n${entries.join("\n")}\n`,
      });
    }
    for (const row of rows) {
      const chain: string[] = [];
      const seen = new Set<string>();
      let current: ConceptRow | undefined = row;
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        chain.unshift(documentNames.get(current.id)!);
        current = rowById.get(parentById.get(current.id) ?? "");
      }
      const documentPath = [spaceNames.get(row.spaceId)!, ...chain].join("/");
      const apps = artifactStore.exportFiles(row.id);
      const draft = (await loadDocument(row)).markdown;
      const published = row.publishedRevision
        ? await store.get(
          revisions(row.id).find((item) =>
            item.number === row.publishedRevision
          )!.objectKey,
        )
        : null;
      const status = row.status === "archived"
        ? "deprecated"
        : published && bodyOnly(published) === bodyOnly(draft)
        ? "stable"
        : "draft";
      files.push({
        path: `okf/${documentPath}.md`,
        body: `---\ntype: ${JSON.stringify(row.type)}\ntitle: ${
          JSON.stringify(row.title)
        }\nstatus: ${status}\nintent: ${row.intent}\n---\n\n${
          bodyOnly(draft).trimEnd()
        }\n`,
      });
      const appNames = uniqueArchiveNames(
        apps.map((app) => ({ id: app.id, label: app.title })),
      );
      for (const app of apps) {
        const appRoot = `apps/${documentPath}/${appNames.get(app.id)!}`;
        for (const file of app.files) {
          files.push({ path: `${appRoot}/${file.path}`, body: file.body });
        }
      }
    }
    return createZip(files);
  }

  async function createConceptForUser(
    userId: string,
    body: Record<string, unknown>,
  ) {
    const spaceId = String(body.spaceId ?? "policies");
    if (
      !space(spaceId) ||
      !await security.checkSpace(userId, "edit", spaceId)
    ) throw new ActionError("Edit access required", 403);

    const title = String(body.title ?? "Incident communication").trim();
    const type = String(body.type ?? "Policy").trim();
    const intent = String(body.intent ?? "canonical") as DocumentIntent;
    const parentId = body.parentId ? String(body.parentId) : null;
    if (
      !title || title.length > 100 ||
      !/^[A-Za-z][A-Za-z0-9 _-]{0,49}$/.test(type) ||
      !DOCUMENT_INTENTS.includes(intent)
    ) {
      throw new ActionError(
        "Title and type are required and must fit their fields",
      );
    }
    if (parentId) {
      const parent = concept(parentId);
      if (
        !parent || parent.spaceId !== spaceId || parent.status !== "active" ||
        !await security.check(userId, "edit", parentId)
      ) throw new ActionError("Parent document not found", 404);
    }

    const baseId = title.toLocaleLowerCase().normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "concept";
    const legacyDefault = Object.keys(body).length === 0;
    const id = legacyDefault
      ? CONCEPT
      : concept(baseId)
      ? `${baseId}-${crypto.randomUUID().slice(0, 6)}`
      : baseId;
    if (concept(id)) throw new ActionError("Concept already exists", 409);

    let initial = legacyDefault ? DEFAULT_MARKDOWN : "";
    if (body.templateId) {
      const selected = template(String(body.templateId));
      if (!selected) throw new ActionError("Template not found", 404);
      const rendered = renderTemplate(
        selected.body,
        body.variables && typeof body.variables === "object"
          ? body.variables as Record<string, unknown>
          : {},
      );
      if ("error" in rendered) throw new ActionError(rendered.error);
      if (
        new TextEncoder().encode(rendered.body).byteLength > MAX_MARKDOWN_BYTES
      ) throw new ActionError("Rendered template is too large");
      initial = rendered.body;
    }

    try {
      await security.ensureHubConcept(id, spaceId);
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO okf_concept (id, spaceId, parentId, sortOrder, title, type, intent, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
      ).run(
        id,
        spaceId,
        parentId,
        nextSortOrder(spaceId, parentId),
        title,
        type,
        intent,
        now,
        now,
      );
      const row = concept(id)!;
      await loadDocument(row, initial);
      await saveDraft(id, initial);
      security.audit(userId, "concept.created", `concept:${id}`);
      return await payload(row, true, userId);
    } catch (error) {
      if (error instanceof ActionError) throw error;
      throw new ActionError(
        error instanceof Error ? error.message : "Creation failed",
        503,
      );
    }
  }

  async function createWorkTraceForUser(
    userId: string,
    conceptId: string,
    body: Record<string, unknown>,
  ) {
    const row = concept(conceptId);
    if (!row || !await security.check(userId, "edit", conceptId)) {
      throw new ActionError("Not found", 404);
    }
    if (row.status !== "active") {
      throw new ActionError("Restore the concept first", 409);
    }
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
    ) throw new ActionError("Complete the trace fields");
    if (sourceUrl) {
      let parsed: URL;
      try {
        parsed = new URL(sourceUrl);
      } catch {
        throw new ActionError("Enter a valid HTTPS source link");
      }
      if (
        parsed.protocol !== "https:" || parsed.username || parsed.password ||
        sourceUrl.length > 500
      ) throw new ActionError("Enter a valid HTTPS source link");
    }
    const id = `trace-${crypto.randomUUID()}`;
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
      userId,
      new Date().toISOString(),
    );
    security.audit(userId, "trace.created", `trace:${id}`);
    return await payload(concept(conceptId)!, true, userId);
  }

  function resolveDocumentLink(item: SearchDocument, href: string) {
    const target = href.split(/[?#]/, 1)[0];
    if (item.sourceId === "hub") {
      const match = target.match(/^\/knowledge\/([^/]+)$/);
      if (!match) return null;
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return null;
      }
    }
    if (!item.path) return null;
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
          linkHrefs: markdownHrefs(content),
        });
      }
    }

    const shared = sharedSource();
    const notion = notionSource();
    for (const item of importedConcepts()) {
      if (!await security.check(userId, "view", item.id)) continue;
      const repository = ["shared", "notion"].includes(item.sourceId)
        ? undefined
        : repositorySource(item.sourceId);
      const source = item.sourceId === "notion" ? notion : repository ?? shared;
      const failed = source?.status === "sync_failed";
      documents.push({
        id: item.id,
        kind: "imported",
        sourceId: item.sourceId,
        sourceLabel: item.sourceId === "notion"
          ? "Notion"
          : item.sourceId !== "shared"
          ? repository?.repositoryUrl ?? "Git repository"
          : shared
          ? `s3://${shared.bucket}/${shared.path}`.replace(/\/$/, "")
          : "Shared store",
        sourceStatus: failed ? "sync_failed" : "current",
        title: item.title,
        type: item.type,
        tags: JSON.parse(item.tags) as string[],
        owner: item.owner ||
          (item.sourceId === "notion"
            ? "Notion workspace"
            : item.sourceId !== "shared"
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

  async function searchKnowledge(
    userId: string,
    userName: string,
    input: Record<string, unknown>,
  ) {
    const query = String(input.query ?? "").trim();
    if (query.length > 120) {
      throw new ActionError("Search is limited to 120 characters");
    }
    const type = String(input.type ?? "").trim().toLocaleLowerCase();
    const tag = String(input.tag ?? "").trim().toLocaleLowerCase();
    const { documents, canIncludeArchived } = await visibleSearchDocuments(
      userId,
      userName,
      input.includeArchived === true,
    );
    const visibleById = new Map(documents.map((item) => [item.id, item]));
    const outgoing = new Map<string, Set<string>>();
    const incoming = new Map<string, Set<string>>();
    for (const item of documents) {
      const targets = new Set<string>();
      for (const href of item.linkHrefs) {
        const id = resolveDocumentLink(item, href);
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
        snippet: searchSnippet(searchText, query, item.title, [
          item.type,
          item.owner,
          item.tags.join(" "),
        ]),
        links: Array.from(outgoing.get(item.id) ?? []).map(relationship),
        backlinks: Array.from(incoming.get(item.id) ?? []).map(relationship),
      };
    }).sort((left, right) =>
      right.score - left.score || left.title.localeCompare(right.title)
    );
    return {
      query,
      results,
      facets: {
        types: Array.from(new Set(documents.map((item) => item.type))).sort(),
        tags: Array.from(new Set(documents.flatMap((item) => item.tags)))
          .sort(),
      },
      canIncludeArchived,
    };
  }

  async function sourceState(userId: string) {
    if (!await security.check(userId, "view")) {
      throw new ActionError("Not found", 404);
    }
    const repositories = [];
    for (const source of repositorySources()) {
      if (await canViewSource(userId, source.id)) {
        repositories.push(sourcePayload(source.id));
      }
    }
    return {
      connectors: connectorPayloads(),
      repositories,
      shared: sharedSource() && await canViewSource(userId, "shared")
        ? sourcePayload("shared")
        : null,
      notion: notionSource() && await canViewSource(userId, "notion")
        ? sourcePayload("notion")
        : null,
    };
  }

  async function appState(userId: string, conceptId: string) {
    if (!conceptId || !await security.check(userId, "view", conceptId)) {
      throw new ActionError("Not found", 404);
    }
    const row = concept(conceptId);
    const canEdit = await security.check(userId, "edit", conceptId);
    if (
      !row ||
      (!canEdit && (row.status === "archived" || !row.publishedRevision))
    ) throw new ActionError("Not found", 404);
    return {
      apps: artifactStore.list(conceptId, canEdit),
      allowedHosts: canEdit ? artifactStore.allowedHosts : [],
      canEdit,
      canPublish: canEdit && security.isOwner(userId),
    };
  }

  async function visibleApp(userId: string, appId: string) {
    const conceptId = artifactStore.conceptId(appId);
    if (!conceptId) throw new ActionError("App not found", 404);
    const state = await appState(userId, conceptId);
    if (!state.apps.some((app) => app?.id === appId)) {
      throw new ActionError("App not found", 404);
    }
    return { conceptId, state };
  }

  const actionCatalog = createActionCatalog([
    {
      name: "knowledge.search",
      tag: "Knowledge",
      title: "Search knowledge",
      description: "Searches only the OKF knowledge visible to the caller.",
      mode: "query",
      approval: "none",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 120 },
          type: { type: "string" },
          tag: { type: "string" },
          includeArchived: { type: "boolean" },
        },
        additionalProperties: false,
      },
      run: (context, input) =>
        searchKnowledge(context.userId, context.userName, input),
    },
    {
      name: "templates.list",
      tag: "Templates",
      title: "List document templates",
      description: "Lists reusable document structures available to an editor.",
      mode: "query",
      approval: "none",
      inputSchema: { type: "object", additionalProperties: false },
      run: async (context) => {
        if (!await security.check(context.userId, "edit")) {
          throw new ActionError("Edit access required", 403);
        }
        return templates().map(templatePayload);
      },
    },
    {
      name: "documents.create",
      tag: "Documents",
      title: "Create document",
      description:
        "Creates a hub-native document, optionally from a listed template.",
      mode: "mutation",
      approval: "confirm",
      inputSchema: {
        type: "object",
        required: ["title", "type", "intent", "spaceId"],
        properties: {
          title: { type: "string", maxLength: 100 },
          type: { type: "string", maxLength: 50 },
          intent: { enum: DOCUMENT_INTENTS },
          spaceId: { type: "string" },
          parentId: { type: "string" },
          templateId: { type: "string" },
          variables: { type: "object" },
        },
        additionalProperties: false,
      },
      run: (context, input) => createConceptForUser(context.userId, input),
    },
    {
      name: "documents.trace.create",
      tag: "Documents",
      title: "Record work trace",
      description:
        "Records an immutable change, decision, incident, or outcome against an editable document.",
      mode: "mutation",
      approval: "confirm",
      inputSchema: {
        type: "object",
        required: [
          "documentId",
          "kind",
          "title",
          "summary",
          "occurredAt",
        ],
        properties: {
          documentId: { type: "string" },
          kind: { enum: TRACE_KINDS },
          title: { type: "string", maxLength: 100 },
          summary: { type: "string", maxLength: 4000 },
          occurredAt: { type: "string" },
          sourceUrl: { type: "string", maxLength: 500 },
        },
        additionalProperties: false,
      },
      run: (context, input) =>
        createWorkTraceForUser(
          context.userId,
          String(input.documentId ?? ""),
          input,
        ),
    },
    {
      name: "documents.get",
      tag: "Documents",
      title: "Get document",
      description: "Returns a permission-filtered hub-native OKF document.",
      mode: "query",
      approval: "none",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      run: async (context, input) => {
        const id = String(input.id ?? "");
        if (!id || !await security.check(context.userId, "view", id)) {
          throw new ActionError("Not found", 404);
        }
        const row = concept(id);
        const canEdit = await security.check(context.userId, "edit", id);
        if (
          !row ||
          (!canEdit && (row.status === "archived" || !row.publishedRevision))
        ) {
          throw new ActionError("Not found", 404);
        }
        return await payload(row, canEdit, context.userId);
      },
    },
    {
      name: "documents.update-draft",
      tag: "Documents",
      title: "Update document draft",
      description:
        "Updates the working Markdown of an editable hub-native document.",
      mode: "mutation",
      approval: "confirm",
      inputSchema: {
        type: "object",
        required: ["id", "markdown"],
        properties: { id: { type: "string" }, markdown: { type: "string" } },
        additionalProperties: false,
      },
      run: async (context, input) => {
        const id = String(input.id ?? "");
        const row = concept(id);
        if (!row || !await security.check(context.userId, "edit", id)) {
          throw new ActionError("Not found", 404);
        }
        if (row.status !== "active") {
          throw new ActionError("Restore the concept first", 409);
        }
        await saveDraft(id, String(input.markdown ?? ""));
        security.audit(
          context.userId,
          "concept.draft.updated",
          `concept:${id}`,
        );
        return await payload(concept(id)!, true, context.userId);
      },
    },
    {
      name: "sources.list",
      tag: "Sources",
      title: "List source connectors",
      description: "Lists visible OKF sources and their current sync status.",
      mode: "query",
      approval: "none",
      inputSchema: { type: "object", additionalProperties: false },
      run: (context) => sourceState(context.userId),
    },
    {
      name: "apps.list",
      tag: "Apps",
      title: "List document Apps",
      description: "Lists governed Apps attached to a visible OKF document.",
      mode: "query",
      approval: "none",
      inputSchema: {
        type: "object",
        required: ["documentId"],
        properties: { documentId: { type: "string" } },
        additionalProperties: false,
      },
      run: (context, input) =>
        appState(context.userId, String(input.documentId ?? "")),
    },
    {
      name: "apps.create",
      tag: "Apps",
      title: "Create App draft",
      description:
        "Creates a reviewed, sandboxed App attached to an editable OKF document.",
      mode: "mutation",
      approval: "confirm",
      inputSchema: {
        type: "object",
        required: ["documentId", "title", "type", "content"],
        properties: {
          documentId: { type: "string" },
          title: { type: "string", maxLength: 100 },
          description: { type: "string", maxLength: 240 },
          type: { enum: ["inline_html", "https_url"] },
          content: { type: "string" },
          grants: {
            type: "array",
            items: { type: "string" },
            maxItems: 20,
          },
        },
        additionalProperties: false,
      },
      run: async (context, input) => {
        const conceptId = String(input.documentId ?? "");
        if (
          !conceptId ||
          !await security.check(context.userId, "edit", conceptId)
        ) throw new ActionError("Not found", 404);
        if (concept(conceptId)?.status !== "active") {
          throw new ActionError("Restore the concept first", 409);
        }
        if (input.type !== "inline_html" && input.type !== "https_url") {
          throw new ActionError("Choose an App type");
        }
        const app = artifactStore.create({
          conceptId,
          title: String(input.title ?? ""),
          description: String(input.description ?? ""),
          grants: requestedAppGrants(input.grants, input.type),
          type: input.type,
          content: String(input.content ?? ""),
          actorUserId: context.userId,
        });
        security.audit(context.userId, "app.created", `app:${app!.id}`);
        return app;
      },
    },
    {
      name: "apps.revise",
      tag: "Apps",
      title: "Revise App",
      description: "Creates a new reviewed version of an existing App.",
      mode: "mutation",
      approval: "confirm",
      inputSchema: {
        type: "object",
        required: ["appId", "content"],
        properties: {
          appId: { type: "string" },
          content: { type: "string" },
          description: { type: "string", maxLength: 240 },
          grants: {
            type: "array",
            items: { type: "string" },
            maxItems: 20,
          },
        },
        additionalProperties: false,
      },
      run: async (context, input) => {
        const appId = String(input.appId ?? "");
        const conceptId = artifactStore.conceptId(appId);
        if (
          !conceptId ||
          !await security.check(context.userId, "edit", conceptId)
        ) throw new ActionError("App not found", 404);
        if (concept(conceptId)?.status !== "active") {
          throw new ActionError("Restore the concept first", 409);
        }
        const app = artifactStore.revise(
          appId,
          String(input.content ?? ""),
          context.userId,
          {
            description: typeof input.description === "string"
              ? input.description
              : undefined,
            grants: input.grants === undefined
              ? undefined
              : requestedAppGrants(input.grants, "inline_html"),
          },
        );
        if (!app) throw new ActionError("App not found", 404);
        security.audit(
          context.userId,
          "app.revised",
          `app:${appId}:version:${app.version}`,
        );
        return app;
      },
    },
    {
      name: "apps.activate",
      tag: "Apps",
      title: "Activate App",
      description: "Approves and activates the current App version.",
      mode: "mutation",
      approval: "confirm",
      inputSchema: {
        type: "object",
        required: ["appId"],
        properties: { appId: { type: "string" } },
        additionalProperties: false,
      },
      run: async (context, input) => {
        if (!security.isOwner(context.userId)) {
          throw new ActionError("Owner access required", 403);
        }
        const appId = String(input.appId ?? "");
        const conceptId = artifactStore.conceptId(appId);
        if (
          !conceptId ||
          !await security.check(context.userId, "edit", conceptId)
        ) throw new ActionError("App not found", 404);
        if (concept(conceptId)?.status !== "active") {
          throw new ActionError("Restore the concept first", 409);
        }
        const app = artifactStore.publish(appId, context.userId);
        if (!app) throw new ActionError("App not found", 404);
        security.audit(
          context.userId,
          "app.activated",
          `app:${appId}:version:${app.version}`,
        );
        return app;
      },
    },
    ...(["list", "get", "set", "remove"] as const).map((operation) => ({
      name: `app.data.${operation}`,
      tag: "App data" as const,
      title: `${operation[0].toUpperCase()}${operation.slice(1)} app data`,
      description: "Reads or writes caller-scoped data for one governed App.",
      mode: operation === "list" || operation === "get"
        ? "query" as const
        : "mutation" as const,
      approval: "none" as const,
      inputSchema: {
        type: "object",
        required: operation === "list"
          ? ["appId", "collection"]
          : operation === "set"
          ? ["appId", "collection", "key", "value"]
          : ["appId", "collection", "key"],
        properties: {
          appId: { type: "string" },
          collection: { type: "string" },
          key: { type: "string" },
          value: {},
        },
        additionalProperties: false,
      },
      run: async (
        context: { userId: string },
        input: Record<string, unknown>,
      ) => {
        const appId = String(input.appId ?? "");
        await visibleApp(context.userId, appId);
        const collection = String(input.collection ?? "");
        const key = String(input.key ?? "");
        if (operation === "list") {
          return artifactStore.data.list(appId, context.userId, collection);
        }
        if (operation === "get") {
          return artifactStore.data.get(appId, context.userId, collection, key);
        }
        if (operation === "set") {
          return artifactStore.data.set(
            appId,
            context.userId,
            collection,
            key,
            input.value,
          );
        }
        return artifactStore.data.remove(
          appId,
          context.userId,
          collection,
          key,
        );
      },
    })),
  ]);
  const availableAppActions = actionCatalog.list(["*"]);

  function requestedAppGrants(
    value: unknown,
    type: "inline_html" | "https_url",
  ) {
    const grants = Array.isArray(value)
      ? value.filter((grant): grant is string => typeof grant === "string")
      : type === "inline_html"
      ? ["app.data.*"]
      : [];
    if (
      grants.some((grant) =>
        !availableAppActions.some((action) =>
          actionAllowed([grant], action.name)
        )
      )
    ) throw new ActionError("Choose available app capabilities");
    return grants;
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
    const securityResponse = url.pathname === "/api/webhooks/github"
      ? null
      : await security.handle(request);
    if (securityResponse) return withCors(securityResponse, request);

    if (url.pathname === "/api/ai/config" && request.method === "GET") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      return Response.json({
        enabled: Boolean(respondWithAI),
        provider: aiProvider,
        model: aiModel,
      }, { headers: cors(request) });
    }

    if (url.pathname === "/api/ai/chat" && request.method === "POST") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      if (!respondWithAI) {
        return Response.json({ error: "Ask OKF is not configured" }, {
          status: 503,
          headers: cors(request),
        });
      }
      const body = await request.json().catch(() => ({})) as {
        conceptId?: unknown;
        importId?: unknown;
        state?: unknown;
        messages?: unknown;
      };
      const conceptId = String(body.conceptId ?? "");
      const importId = String(body.importId ?? "");
      if (Boolean(conceptId) === Boolean(importId)) {
        return Response.json({ error: "Choose one document" }, {
          status: 400,
          headers: cors(request),
        });
      }
      if (
        !Array.isArray(body.messages) || body.messages.length < 1 ||
        body.messages.length > 12
      ) {
        return Response.json({ error: "Send 1–12 chat messages" }, {
          status: 400,
          headers: cors(request),
        });
      }
      const messages = body.messages.map((message) => {
        if (!message || typeof message !== "object") return null;
        const role = "role" in message ? message.role : undefined;
        const content = "content" in message
          ? String(message.content ?? "").trim()
          : "";
        return (role === "user" || role === "assistant") && content &&
            content.length <= 4_000
          ? { role, content }
          : null;
      });
      if (
        messages.some((message) => !message) ||
        messages.at(-1)?.role !== "user"
      ) {
        return Response.json({ error: "Chat messages are invalid" }, {
          status: 400,
          headers: cors(request),
        });
      }
      let document: AIRequest["document"];
      let auditTarget: string;
      if (importId) {
        const item = db.prepare(
          "SELECT * FROM okf_imported_concept WHERE id = ? AND status IN ('current', 'invalid')",
        ).get(importId) as ImportedConceptRow | undefined;
        if (
          !item || !await security.check(current.user.id, "view", item.id)
        ) {
          return Response.json({ error: "Document not found" }, {
            status: 404,
            headers: cors(request),
          });
        }
        try {
          document = {
            title: item.title,
            space: item.sourceId,
            state: "source",
            markdown: withoutFrontmatter(await store.get(item.objectKey)),
          };
        } catch (error) {
          console.error("Ask OKF could not read the imported document", error);
          return Response.json({ error: "Ask OKF could not answer" }, {
            status: 503,
            headers: cors(request),
          });
        }
        auditTarget = `import:${item.id}`;
      } else {
        const row = concept(conceptId);
        const canEdit = row &&
          await security.check(current.user.id, "edit", conceptId);
        if (
          !row ||
          !await security.check(current.user.id, "view", conceptId) ||
          (!canEdit && (!row.publishedRevision || row.status !== "active"))
        ) {
          return Response.json({ error: "Document not found" }, {
            status: 404,
            headers: cors(request),
          });
        }
        const payloadDocument = await payload(
          row,
          Boolean(canEdit),
          current.user.id,
        );
        const state = !canEdit || body.state === "published"
          ? "published"
          : "draft";
        const markdown = state === "published"
          ? payloadDocument.published
          : payloadDocument.draft;
        if (!markdown) {
          return Response.json({ error: `${state} content is unavailable` }, {
            status: 409,
            headers: cors(request),
          });
        }
        document = {
          title: row.title,
          space: space(row.spaceId)?.name ?? row.spaceId,
          state,
          markdown,
        };
        auditTarget = `concept:${conceptId}`;
      }
      try {
        const message = await respondWithAI({
          messages: messages as {
            role: "user" | "assistant";
            content: string;
          }[],
          document,
        });
        security.audit(current.user.id, "ai.asked", auditTarget);
        return Response.json({ message }, { headers: cors(request) });
      } catch (error) {
        console.error("Ask OKF failed", error);
        return Response.json({ error: "Ask OKF could not answer" }, {
          status: 503,
          headers: cors(request),
        });
      }
    }

    const spaceExportRoute = url.pathname.match(
      /^\/api\/exports\/spaces\/([^/]+)$/,
    );
    if (
      request.method === "GET" &&
      (url.pathname === "/api/exports/workspace" || spaceExportRoute)
    ) {
      const current = await security.session(request);
      if (!current) {
        return new Response("Sign in required", {
          status: 401,
          headers: cors(request),
        });
      }
      const selectedSpace = spaceExportRoute
        ? space(decodeURIComponent(spaceExportRoute[1]))
        : null;
      if (
        url.pathname === "/api/exports/workspace"
          ? !security.isOwner(current.user.id)
          : !selectedSpace ||
            !await security.checkSpace(
              current.user.id,
              "edit",
              selectedSpace.id,
            )
      ) {
        return new Response("Export not found", {
          status: 404,
          headers: cors(request),
        });
      }
      try {
        const scope = selectedSpace ? [selectedSpace] : spaces();
        const archive = await portableArchive(current.user.id, scope);
        const date = new Date().toISOString().slice(0, 10);
        const filename = selectedSpace
          ? `okf-${archiveSegment(selectedSpace.id, "space")}-${date}.zip`
          : `okf-workspace-${date}.zip`;
        security.audit(
          current.user.id,
          selectedSpace ? "space.exported" : "workspace.exported",
          selectedSpace ? `space:${selectedSpace.id}` : "workspace:company",
        );
        const headers = new Headers(cors(request));
        headers.set("content-type", "application/zip");
        headers.set(
          "content-disposition",
          `attachment; filename="${filename}"`,
        );
        return new Response(archive as BodyInit, { headers });
      } catch (error) {
        return new Response(
          error instanceof Error ? error.message : "Export failed",
          {
            status: error instanceof ExportArchiveError ? 413 : 503,
            headers: cors(request),
          },
        );
      }
    }

    const connectingDisabled = request.method === "POST"
      ? url.pathname === "/api/sources/github" ||
          /^\/api\/sources\/repositories(?:\/[a-z0-9-]+)?$/.test(url.pathname)
        ? "git"
        : url.pathname === "/api/sources/shared"
        ? "s3"
        : url.pathname === "/api/sources/notion"
        ? "notion"
        : null
      : null;
    if (connectingDisabled && !connectorEnabled(connectingDisabled)) {
      return Response.json({ error: "Connector is not enabled" }, {
        status: 409,
        headers: cors(request),
      });
    }

    if (url.pathname === "/api/openapi.json" && request.method === "GET") {
      return Response.json(actionCatalog.openApi(), { headers: cors(request) });
    }

    if (url.pathname === "/api/webhooks/github" && request.method === "POST") {
      if (!githubApp) return new Response("Not found", { status: 404 });
      const raw = new Uint8Array(await request.arrayBuffer());
      if (
        !githubApp.verify(raw, request.headers.get("x-hub-signature-256") ?? "")
      ) {
        return Response.json({ error: "Invalid webhook signature" }, {
          status: 401,
        });
      }
      const deliveryId = request.headers.get("x-github-delivery")?.trim() ?? "";
      const event = request.headers.get("x-github-event")?.trim() ?? "";
      if (!deliveryId || deliveryId.length > 128 || !event) {
        return Response.json({ error: "Missing GitHub delivery headers" }, {
          status: 400,
        });
      }
      let payload: {
        installation?: { id?: number };
        repository?: { id?: number };
      };
      try {
        payload = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return Response.json({ error: "Invalid GitHub webhook payload" }, {
          status: 400,
        });
      }
      const inserted = db.prepare(
        "INSERT OR IGNORE INTO okf_github_delivery (deliveryId, event, receivedAt) VALUES (?, ?, ?)",
      ).run(deliveryId, event, new Date().toISOString()).changes;
      if (!inserted) return Response.json({ duplicate: true }, { status: 202 });
      if (event !== "push") {
        return Response.json({ accepted: true, refreshed: 0 }, { status: 202 });
      }
      const installationId = Number(payload.installation?.id);
      const repositoryId = Number(payload.repository?.id);
      if (
        !Number.isSafeInteger(installationId) || installationId < 1 ||
        !Number.isSafeInteger(repositoryId) || repositoryId < 1
      ) {
        return Response.json({ error: "Invalid GitHub push payload" }, {
          status: 400,
        });
      }
      const sources = db.prepare(
        "SELECT id FROM okf_repository_source WHERE githubInstallationId = ? AND githubRepositoryId = ?",
      ).all(installationId, repositoryId) as { id: string }[];
      void Promise.allSettled(
        sources.map((source) => refreshRepository(source.id, "webhook")),
      );
      return Response.json({ accepted: true, refreshed: sources.length }, {
        status: 202,
      });
    }
    if (url.pathname === "/api/v1/actions" && request.method === "GET") {
      const actor = await security.authenticate(request);
      if (!actor) {
        return Response.json({ error: "Sign in or use an API key" }, {
          status: 401,
          headers: cors(request),
        });
      }
      return Response.json({ actions: actionCatalog.list(actor.scopes) }, {
        headers: cors(request),
      });
    }
    const actionRoute = url.pathname.match(/^\/api\/v1\/actions\/([^/]+)$/);
    if (actionRoute && request.method === "POST") {
      const actor = await security.authenticate(request);
      if (!actor) {
        return Response.json({ error: "Sign in or use an API key" }, {
          status: 401,
          headers: cors(request),
        });
      }
      const input = await request.json().catch(() => ({}));
      if (!input || Array.isArray(input) || typeof input !== "object") {
        return Response.json({ error: "Action input must be a JSON object" }, {
          status: 400,
          headers: cors(request),
        });
      }
      try {
        const result = await actionCatalog.invoke(
          decodeURIComponent(actionRoute[1]),
          { userId: actor.user.id, userName: actor.user.name },
          input as Record<string, unknown>,
          actor.scopes,
        );
        return Response.json({ result }, { headers: cors(request) });
      } catch (error) {
        const status = error instanceof ActionError
          ? error.status
          : error instanceof MarkdownTooLarge
          ? 413
          : error instanceof DocumentLocked
          ? 423
          : error instanceof ArtifactInputError
          ? 400
          : 503;
        return Response.json({
          error: error instanceof Error ? error.message : "Action failed",
        }, { status, headers: cors(request) });
      }
    }

    if (url.pathname === "/api/sources" && request.method === "GET") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      try {
        return Response.json(await sourceState(current.user.id), {
          headers: cors(request),
        });
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : "Sources unavailable",
        }, {
          status: error instanceof ActionError ? error.status : 503,
          headers: cors(request),
        });
      }
    }
    const connectorSettingPath = url.pathname.match(
      /^\/api\/connectors\/([a-z0-9-]+)\/enabled$/,
    );
    if (connectorSettingPath && request.method === "PUT") {
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
      const connector = connectors.definition(connectorSettingPath[1]);
      if (!connector) {
        return Response.json({ error: "Connector not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      const body = await request.json().catch(() => ({})) as {
        enabled?: unknown;
      };
      if (typeof body.enabled !== "boolean") {
        return Response.json({ error: "enabled must be a boolean" }, {
          status: 400,
          headers: cors(request),
        });
      }
      db.prepare(
        "UPDATE okf_connector_setting SET enabled = ? WHERE id = ?",
      ).run(body.enabled ? 1 : 0, connector.id);
      return Response.json({ ...connector, enabled: body.enabled }, {
        headers: cors(request),
      });
    }
    const connectorConnectPath = url.pathname.match(
      /^\/api\/connectors\/([a-z0-9-]+)\/connect$/,
    );
    if (connectorConnectPath && request.method === "POST") {
      const connector = connectors.definition(connectorConnectPath[1]);
      if (!connector?.connectPath || !connectorEnabled(connector.id)) {
        return Response.json({ error: "Connector is not enabled" }, {
          status: 409,
          headers: cors(request),
        });
      }
      return await fetch(
        new Request(new URL(connector.connectPath, request.url), request),
      );
    }
    if (
      url.pathname === "/api/sources/github/setup" && request.method === "GET"
    ) {
      const current = await security.session(request);
      const installationId = Number(url.searchParams.get("installation_id"));
      if (
        !current || !security.isOwner(current.user.id) ||
        !Number.isSafeInteger(installationId) || installationId < 1
      ) {
        return Response.redirect(
          new URL("/sources?github_error=setup", request.url),
          303,
        );
      }
      return Response.redirect(
        new URL(`/sources?github_installation=${installationId}`, request.url),
        303,
      );
    }
    if (url.pathname === "/api/sources/github" && request.method === "GET") {
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
        configured: Boolean(githubApp),
        installUrl: githubApp?.installUrl ?? null,
        setupUrl: new URL("/api/sources/github/setup", baseURL ?? request.url)
          .toString(),
      }, { headers: cors(request) });
    }
    if (
      url.pathname === "/api/sources/github/repositories" &&
      request.method === "GET"
    ) {
      const current = await security.session(request);
      if (!current || !security.isOwner(current.user.id)) {
        return Response.json({
          error: current ? "Owner access required" : "Sign in required",
        }, {
          status: current ? 403 : 401,
          headers: cors(request),
        });
      }
      if (!githubApp) {
        return Response.json({ error: "GitHub App is not configured" }, {
          status: 503,
          headers: cors(request),
        });
      }
      const installationId = Number(url.searchParams.get("installationId"));
      if (!Number.isSafeInteger(installationId) || installationId < 1) {
        return Response.json({ error: "Invalid GitHub installation" }, {
          status: 400,
          headers: cors(request),
        });
      }
      try {
        return Response.json({
          repositories: await githubApp.repositories(installationId),
        }, { headers: cors(request) });
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : "GitHub unavailable",
        }, { status: 502, headers: cors(request) });
      }
    }
    if (
      url.pathname === "/api/sources/github/folders" &&
      request.method === "GET"
    ) {
      const current = await security.session(request);
      if (!current || !security.isOwner(current.user.id)) {
        return Response.json({
          error: current ? "Owner access required" : "Sign in required",
        }, {
          status: current ? 403 : 401,
          headers: cors(request),
        });
      }
      if (!githubApp) {
        return Response.json({ error: "GitHub App is not configured" }, {
          status: 503,
          headers: cors(request),
        });
      }
      const installationId = Number(url.searchParams.get("installationId"));
      const repositoryId = Number(url.searchParams.get("repositoryId"));
      if (
        !Number.isSafeInteger(installationId) || installationId < 1 ||
        !Number.isSafeInteger(repositoryId) || repositoryId < 1
      ) {
        return Response.json({
          error: "Choose a GitHub installation and repository",
        }, { status: 400, headers: cors(request) });
      }
      try {
        const repository = (await githubApp.repositories(installationId)).find(
          (item) => item.id === repositoryId,
        );
        if (!repository) {
          throw new Error("Repository is not available to this installation");
        }
        return Response.json({
          folders: await githubApp.folders(installationId, repository),
        }, { headers: cors(request) });
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : "GitHub unavailable",
        }, { status: 502, headers: cors(request) });
      }
    }
    if (url.pathname === "/api/sources/github" && request.method === "POST") {
      const current = await security.session(request);
      if (!current || !security.isOwner(current.user.id)) {
        return Response.json({
          error: current ? "Owner access required" : "Sign in required",
        }, {
          status: current ? 403 : 401,
          headers: cors(request),
        });
      }
      if (!githubApp) {
        return Response.json({ error: "GitHub App is not configured" }, {
          status: 503,
          headers: cors(request),
        });
      }
      const body = await request.json().catch(() => ({})) as Record<
        string,
        unknown
      >;
      const installationId = Number(body.installationId);
      const repositoryId = Number(body.repositoryId);
      const folder = String(body.folder ?? "okf").trim().replace(/^\.\//, "") ||
        ".";
      if (
        !Number.isSafeInteger(installationId) || installationId < 1 ||
        !Number.isSafeInteger(repositoryId) || repositoryId < 1 ||
        folder.startsWith("/") || folder.includes("\\") ||
        folder.split("/").includes("..")
      ) {
        return Response.json(
          { error: "Choose a GitHub repository and folder" },
          {
            status: 400,
            headers: cors(request),
          },
        );
      }
      try {
        const repository = (await githubApp.repositories(installationId)).find(
          (item) => item.id === repositoryId,
        );
        if (!repository) {
          throw new Error("Repository is not available to this installation");
        }
        const folders = await githubApp.folders(installationId, repository);
        if (!folders.includes(folder)) {
          throw new Error("Choose a folder from the repository");
        }
        const sourceId = repositorySources().length
          ? `repository-${crypto.randomUUID()}`
          : "repository";
        db.prepare(
          "INSERT INTO okf_repository_source (id, repositoryUrl, folder, status, githubInstallationId, githubRepositoryId, githubFullName, automationIntervalMinutes) VALUES (?, ?, ?, 'syncing', ?, ?, ?, ?)",
        ).run(
          sourceId,
          repository.cloneUrl,
          folder,
          installationId,
          repository.id,
          repository.fullName,
          defaultAutomationIntervalMinutes,
        );
        try {
          await refreshRepository(sourceId, "connect");
          return Response.json(sourcePayload(sourceId), {
            status: 201,
            headers: cors(request),
          });
        } catch {
          return Response.json(sourcePayload(sourceId), {
            status: 502,
            headers: cors(request),
          });
        }
      } catch (error) {
        return Response.json({
          error: error instanceof Error
            ? error.message
            : "GitHub connection failed",
        }, { status: 502, headers: cors(request) });
      }
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
          "UPDATE okf_repository_source SET repositoryUrl = ?, folder = ?, credentialsCipher = ?, status = 'syncing', error = NULL, githubInstallationId = NULL, githubRepositoryId = NULL, githubFullName = NULL WHERE id = ?",
        ).run(parsed.toString(), folder, credentialsCipher, sourceId);
      } else {
        db.prepare(
          "INSERT INTO okf_repository_source (id, repositoryUrl, folder, credentialsCipher, status, automationIntervalMinutes) VALUES (?, ?, ?, ?, 'syncing', ?)",
        ).run(
          sourceId,
          parsed.toString(),
          folder,
          credentialsCipher,
          defaultAutomationIntervalMinutes,
        );
      }
      try {
        await refreshRepository(sourceId, existing ? "manual" : "connect");
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
          "INSERT INTO okf_shared_source (id, endpoint, bucket, path, region, credentialsCipher, status, automationIntervalMinutes) VALUES ('shared', ?, ?, ?, ?, ?, 'syncing', ?)",
        ).run(
          endpoint.toString(),
          bucket,
          path,
          region,
          credentialsCipher,
          defaultAutomationIntervalMinutes,
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
    if (url.pathname === "/api/sources/notion" && request.method === "POST") {
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
      const body = await request.json().catch(() => ({})) as {
        token?: unknown;
      };
      const token = String(body.token ?? "").trim();
      if (token.length < 20) {
        return Response.json({ error: "Enter a Notion integration token" }, {
          status: 400,
          headers: cors(request),
        });
      }
      const existing = notionSource();
      const credentialsCipher = await credentialVault.encrypt({ token });
      if (existing) {
        db.prepare(
          "UPDATE okf_notion_source SET credentialsCipher = ?, status = 'syncing', error = NULL WHERE id = 'notion'",
        ).run(credentialsCipher);
      } else {
        db.prepare(
          "INSERT INTO okf_notion_source (id, credentialsCipher, status, automationIntervalMinutes) VALUES ('notion', ?, 'syncing', ?)",
        ).run(credentialsCipher, defaultAutomationIntervalMinutes);
      }
      try {
        await refreshNotion();
        return Response.json(sourcePayload("notion"), {
          status: existing ? 200 : 201,
          headers: cors(request),
        });
      } catch {
        return Response.json(sourcePayload("notion"), {
          status: 502,
          headers: cors(request),
        });
      }
    }
    if (
      url.pathname === "/api/sources/notion/refresh" &&
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
      if (!notionSource()) {
        return Response.json({ error: "Notion is not connected" }, {
          status: 404,
          headers: cors(request),
        });
      }
      try {
        await refreshNotion();
        return Response.json(sourcePayload("notion"), {
          headers: cors(request),
        });
      } catch {
        return Response.json(sourcePayload("notion"), {
          status: 502,
          headers: cors(request),
        });
      }
    }
    const sourceSchedulePath = url.pathname.match(
      /^\/api\/sources\/([a-z0-9-]+)\/schedule$/,
    );
    if (sourceSchedulePath && request.method === "PUT") {
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
      const sourceId = sourceSchedulePath[1];
      const source = sourceId === "shared"
        ? sharedSource()
        : sourceId === "notion"
        ? notionSource()
        : repositorySource(sourceId);
      if (!source) {
        return Response.json({ error: "Source not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      const body = await request.json().catch(() => ({})) as {
        intervalMinutes?: unknown;
      };
      const intervalMinutes = Number(body.intervalMinutes);
      if (
        !Number.isSafeInteger(intervalMinutes) ||
        !SOURCE_AUTOMATION_INTERVALS.includes(intervalMinutes)
      ) {
        return Response.json({ error: "Choose a supported check schedule" }, {
          status: 400,
          headers: cors(request),
        });
      }
      db.prepare(
        `UPDATE ${
          sourceId === "shared"
            ? "okf_shared_source"
            : sourceId === "notion"
            ? "okf_notion_source"
            : "okf_repository_source"
        } SET automationIntervalMinutes = ? WHERE id = ?`,
      ).run(intervalMinutes, sourceId);
      return Response.json(sourcePayload(sourceId), {
        headers: cors(request),
      });
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
    const appFileRoute = url.pathname.match(
      /^\/api\/apps\/([^/]+)\/files(?:\/(.*))?$/,
    );
    if (appFileRoute && request.method === "GET") {
      const current = await security.session(request);
      if (!current) {
        return new Response("Sign in required", {
          status: 401,
          headers: cors(request),
        });
      }
      try {
        const appId = decodeURIComponent(appFileRoute[1]);
        const { state } = await visibleApp(current.user.id, appId);
        const file = artifactStore.file(
          appId,
          decodeURIComponent(appFileRoute[2] ?? ""),
          state.canEdit,
        );
        if (!file) {
          return new Response("App file not found", {
            status: 404,
            headers: cors(request),
          });
        }
        const headers = new Headers(cors(request));
        headers.set("content-type", file.type);
        headers.set("cache-control", "no-store");
        headers.set("x-content-type-options", "nosniff");
        return new Response(file.body as BodyInit, { headers });
      } catch (error) {
        return new Response(
          error instanceof Error ? error.message : "App file unavailable",
          {
            status: error instanceof ActionError ? error.status : 400,
            headers: cors(request),
          },
        );
      }
    }
    if (
      (url.pathname === "/api/artifacts" || url.pathname === "/api/apps") &&
      request.method === "GET"
    ) {
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
      const state = await appState(current.user.id, conceptId);
      return Response.json(
        url.pathname === "/api/artifacts"
          ? {
            artifacts: state.apps,
            allowedHosts: state.allowedHosts,
            canEdit: state.canEdit,
            canPublish: state.canPublish,
          }
          : {
            ...state,
            artifacts: state.apps,
            availableActions: canEdit ? availableAppActions : [],
          },
        { headers: cors(request) },
      );
    }
    if (
      (url.pathname === "/api/artifacts" || url.pathname === "/api/apps") &&
      request.method === "POST"
    ) {
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
      if (url.pathname === "/api/apps") {
        try {
          const input: Record<string, unknown> = {
            ...body,
            documentId: body.documentId ?? body.conceptId,
          };
          delete input.conceptId;
          const app = await actionCatalog.invoke(
            "apps.create",
            { userId: current.user.id, userName: current.user.name },
            input,
          );
          return Response.json(app, { status: 201, headers: cors(request) });
        } catch (error) {
          return Response.json({
            error: error instanceof Error
              ? error.message
              : "App creation failed",
          }, {
            status: error instanceof ActionError
              ? error.status
              : error instanceof ArtifactInputError
              ? 400
              : 503,
            headers: cors(request),
          });
        }
      }
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
          description: String(body.description ?? ""),
          grants: requestedAppGrants(body.grants, body.type),
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
      /^\/api\/(?:artifacts|apps)\/([^/]+)\/(?:publish|activate)$/,
    );
    if (artifactPublish && request.method === "POST") {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
          headers: cors(request),
        });
      }
      if (url.pathname.startsWith("/api/apps/")) {
        try {
          const app = await actionCatalog.invoke(
            "apps.activate",
            { userId: current.user.id, userName: current.user.name },
            { appId: decodeURIComponent(artifactPublish[1]) },
          );
          return Response.json(app, { headers: cors(request) });
        } catch (error) {
          return Response.json({
            error: error instanceof Error
              ? error.message
              : "App activation failed",
          }, {
            status: error instanceof ActionError ? error.status : 503,
            headers: cors(request),
          });
        }
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
    const artifactRevision = url.pathname.match(
      /^\/api\/(?:artifacts|apps)\/([^/]+)$/,
    );
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
        description?: unknown;
        grants?: unknown;
      };
      if (url.pathname.startsWith("/api/apps/")) {
        try {
          const input: Record<string, unknown> = {
            appId: id,
            content: body.content,
          };
          if (body.description !== undefined) {
            input.description = body.description;
          }
          if (body.grants !== undefined) input.grants = body.grants;
          const app = await actionCatalog.invoke(
            "apps.revise",
            { userId: current.user.id, userName: current.user.name },
            input,
          );
          return Response.json(app, { headers: cors(request) });
        } catch (error) {
          return Response.json({
            error: error instanceof Error ? error.message : "App update failed",
          }, {
            status: error instanceof ActionError
              ? error.status
              : error instanceof ArtifactInputError
              ? 400
              : 503,
            headers: cors(request),
          });
        }
      }
      try {
        const artifact = artifactStore.revise(
          id,
          String(body.content ?? ""),
          current.user.id,
          {
            description: typeof body.description === "string"
              ? body.description
              : undefined,
            grants: body.grants === undefined
              ? undefined
              : requestedAppGrants(body.grants, "inline_html"),
          },
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
      try {
        return Response.json(
          await searchKnowledge(
            current.user.id,
            current.user.name,
            {
              query: url.searchParams.get("q") ?? "",
              type: url.searchParams.get("type") ?? "",
              tag: url.searchParams.get("tag") ?? "",
              includeArchived:
                url.searchParams.get("includeArchived") === "true",
            },
          ),
          { headers: cors(request) },
        );
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : "Search failed",
        }, {
          status: error instanceof ActionError ? error.status : 503,
          headers: cors(request),
        });
      }
    }

    if (url.pathname === "/api/templates" && request.method === "GET") {
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
      return Response.json(
        templates().map(templatePayload),
        { headers: cors(request) },
      );
    }

    if (url.pathname === "/api/templates" && request.method === "POST") {
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
      const body = await request.json().catch(() => ({})) as Record<
        string,
        unknown
      >;
      const name = String(body.name ?? "").trim();
      const description = String(body.description ?? "").trim();
      const markdown = String(body.body ?? "");
      if (
        !name || name.length > 80 || description.length > 240 ||
        !markdown.trim() ||
        new TextEncoder().encode(markdown).byteLength > MAX_MARKDOWN_BYTES
      ) {
        return Response.json({
          error: "Template fields are invalid or too long",
        }, {
          status: 400,
          headers: cors(request),
        });
      }
      if (
        templates().some((item) =>
          item.name.toLocaleLowerCase() === name.toLocaleLowerCase()
        )
      ) {
        return Response.json({ error: "Template name already exists" }, {
          status: 409,
          headers: cors(request),
        });
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      try {
        db.prepare(
          "INSERT INTO okf_template (id, name, description, body, variables, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          id,
          name,
          description,
          markdown,
          JSON.stringify(templateVariables(markdown)),
          current.user.id,
          now,
          now,
        );
        security.audit(current.user.id, "template.created", `template:${id}`);
        return Response.json(templatePayload(template(id)!), {
          status: 201,
          headers: cors(request),
        });
      } catch {
        return Response.json({ error: "Template name already exists" }, {
          status: 409,
          headers: cors(request),
        });
      }
    }

    const templateRoute = url.pathname.match(/^\/api\/templates\/([^/]+)$/);
    if (templateRoute && request.method === "DELETE") {
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
      const id = templateRoute[1];
      if (id === UNDERSTANDING_BRIEF_TEMPLATE.id) {
        return Response.json(
          { error: "Built-in templates cannot be deleted" },
          {
            status: 400,
            headers: cors(request),
          },
        );
      }
      if (!template(id)) {
        return Response.json({ error: "Template not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      db.prepare("DELETE FROM okf_template WHERE id = ?").run(id);
      security.audit(current.user.id, "template.deleted", `template:${id}`);
      return new Response(null, { status: 204, headers: cors(request) });
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
        icon?: unknown;
      };
      const name = String(body.name ?? "").trim();
      const icon = String(body.icon ?? "").trim();
      if (!name || name.length > 60) {
        return Response.json({ error: "Space name must be 1–60 characters" }, {
          status: 400,
          headers: cors(request),
        });
      }
      if (icon.length > 16 || /[\r\n]/.test(icon)) {
        return Response.json({
          error: "Space icon must be at most 16 characters",
        }, {
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
          "INSERT INTO okf_space (id, name, icon, createdAt) VALUES (?, ?, ?, ?)",
        ).run(id, name, icon, now);
        security.audit(current.user.id, "space.created", `space:${id}`);
        return Response.json({ id, name, icon, createdAt: now, count: 0 }, {
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
        icon?: unknown;
      };
      const name = String(body.name ?? "").trim();
      const icon = body.icon === undefined
        ? item.icon
        : String(body.icon).trim();
      if (!name || name.length > 60) {
        return Response.json({ error: "Space name must be 1–60 characters" }, {
          status: 400,
          headers: cors(request),
        });
      }
      if (icon.length > 16 || /[\r\n]/.test(icon)) {
        return Response.json({
          error: "Space icon must be at most 16 characters",
        }, {
          status: 400,
          headers: cors(request),
        });
      }
      db.prepare("UPDATE okf_space SET name = ?, icon = ? WHERE id = ?").run(
        name,
        icon,
        spaceId,
      );
      security.audit(current.user.id, "space.renamed", `space:${spaceId}`);
      return Response.json({ ...item, name, icon }, { headers: cors(request) });
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
            openCommentCount: openCommentCount(row.id),
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
      try {
        return Response.json(
          await createConceptForUser(current.user.id, body),
          {
            status: 201,
            headers: cors(request),
          },
        );
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : "Creation failed",
        }, {
          status: error instanceof ActionError ? error.status : 503,
          headers: cors(request),
        });
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
      const body = await request.json().catch(() => ({})) as Record<
        string,
        unknown
      >;
      try {
        return Response.json(
          await createWorkTraceForUser(
            current.user.id,
            traceCollectionRoute[1],
            body,
          ),
          { status: 201, headers: cors(request) },
        );
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : "Work trace failed",
        }, {
          status: error instanceof ActionError ? error.status : 503,
          headers: cors(request),
        });
      }
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
      conceptRoute && request.method === "POST" && conceptRoute[2] === "move"
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
        !row || row.lockedAt ||
        !await security.check(current.user.id, "edit", conceptId)
      ) {
        return Response.json({ error: "Document cannot be moved" }, {
          status: row?.lockedAt ? 423 : 404,
          headers: cors(request),
        });
      }
      const body = await request.json().catch(() => ({})) as Record<
        string,
        unknown
      >;
      const spaceId = String(body.spaceId ?? row.spaceId);
      const parentId = body.parentId ? String(body.parentId) : null;
      const targetSpace = space(spaceId);
      const parent = parentId ? concept(parentId) : null;
      if (
        !targetSpace || invalidParent(conceptId, parentId) ||
        (parentId &&
          (!parent || parent.spaceId !== spaceId ||
            parent.status !== "active")) ||
        !await security.checkSpace(current.user.id, "edit", spaceId)
      ) {
        return Response.json({ error: "Move destination not found" }, {
          status: 404,
          headers: cors(request),
        });
      }
      const destination = concepts().filter((item) =>
        item.id !== conceptId && item.spaceId === spaceId &&
        item.parentId === parentId
      ).map((item) => item.id);
      const requestedIndex = Number(body.index);
      destination.splice(
        Number.isInteger(requestedIndex)
          ? Math.max(0, Math.min(requestedIndex, destination.length))
          : destination.length,
        0,
        conceptId,
      );
      const previousSiblings = concepts().filter((item) =>
        item.id !== conceptId && item.spaceId === row.spaceId &&
        item.parentId === row.parentId
      ).map((item) => item.id);
      try {
        await security.moveHubConcept(conceptId, row.spaceId, spaceId);
        db.exec("BEGIN");
        db.prepare(
          "UPDATE okf_concept SET spaceId = ?, parentId = ?, updatedAt = ? WHERE id = ?",
        ).run(spaceId, parentId, new Date().toISOString(), conceptId);
        previousSiblings.forEach((id, index) =>
          db.prepare("UPDATE okf_concept SET sortOrder = ? WHERE id = ?").run(
            index,
            id,
          )
        );
        destination.forEach((id, index) =>
          db.prepare("UPDATE okf_concept SET sortOrder = ? WHERE id = ?").run(
            index,
            id,
          )
        );
        db.exec("COMMIT");
        if (row.spaceId !== spaceId) {
          (await loadDocument(row)).clients.forEach((client) =>
            client.close(1000, "Concept moved")
          );
        }
        security.audit(
          current.user.id,
          "concept.moved",
          `concept:${conceptId}`,
        );
        return Response.json(
          await payload(concept(conceptId)!, true, current.user.id),
          { headers: cors(request) },
        );
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // No transaction was started.
        }
        return Response.json({
          error: error instanceof Error ? error.message : "Move failed",
        }, { status: 503, headers: cors(request) });
      }
    }
    if (
      conceptRoute && conceptRoute[2] === "comments" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      const current = await security.session(request);
      const conceptId = conceptRoute[1];
      if (
        !current || !concept(conceptId) ||
        !await security.check(current.user.id, "view", conceptId)
      ) {
        return Response.json({
          error: current ? "Not found" : "Sign in required",
        }, {
          status: current ? 404 : 401,
          headers: cors(request),
        });
      }
      if (request.method === "GET") {
        const status = url.searchParams.get("status") === "resolved"
          ? "resolved"
          : "open";
        return Response.json(commentThreads(conceptId, status), {
          headers: cors(request),
        });
      }
      const body = await request.json().catch(() => ({})) as Record<
        string,
        unknown
      >;
      const message = String(body.body ?? "").trim();
      const anchorText = String(body.anchorText ?? "").trim().slice(0, 300);
      const anchorStart = Number(body.anchorStart);
      const anchorEnd = Number(body.anchorEnd);
      if (!message || message.length > 4000) {
        return Response.json({ error: "Comment must be 1–4000 characters" }, {
          status: 400,
          headers: cors(request),
        });
      }
      const id = crypto.randomUUID();
      const commentId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.exec("BEGIN");
      try {
        db.prepare(
          `INSERT INTO okf_comment_thread
           (id, conceptId, anchorText, anchorStart, anchorEnd, revisionNumber, createdBy, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          conceptId,
          anchorText,
          anchorText && Number.isInteger(anchorStart) && anchorStart >= 0
            ? anchorStart
            : null,
          anchorText && Number.isInteger(anchorEnd) && anchorEnd >= anchorStart
            ? anchorEnd
            : null,
          Number.isInteger(Number(body.revisionNumber))
            ? Number(body.revisionNumber)
            : null,
          current.user.id,
          now,
        );
        db.prepare(
          `INSERT INTO okf_comment
           (id, threadId, authorId, body, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(commentId, id, current.user.id, message, now, now);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      security.audit(
        current.user.id,
        "comment.created",
        `concept:${conceptId}`,
      );
      return Response.json(
        commentThreads(conceptId, "open").find((thread) => thread.id === id),
        {
          status: 201,
          headers: cors(request),
        },
      );
    }

    const commentThreadRoute = url.pathname.match(
      /^\/api\/comment-threads\/([^/]+)(?:\/(replies))?$/,
    );
    if (commentThreadRoute && ["POST", "PATCH"].includes(request.method)) {
      const current = await security.session(request);
      const thread = db.prepare(
        "SELECT * FROM okf_comment_thread WHERE id = ?",
      ).get(commentThreadRoute[1]) as CommentThreadRow | undefined;
      if (
        !current || !thread ||
        !await security.check(current.user.id, "view", thread.conceptId)
      ) {
        return Response.json({
          error: current ? "Not found" : "Sign in required",
        }, {
          status: current ? 404 : 401,
          headers: cors(request),
        });
      }
      const body = await request.json().catch(() => ({})) as Record<
        string,
        unknown
      >;
      if (request.method === "POST" && commentThreadRoute[2] === "replies") {
        const message = String(body.body ?? "").trim();
        if (!message || message.length > 4000) {
          return Response.json({ error: "Reply must be 1–4000 characters" }, {
            status: 400,
            headers: cors(request),
          });
        }
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO okf_comment
           (id, threadId, authorId, body, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          crypto.randomUUID(),
          thread.id,
          current.user.id,
          message,
          now,
          now,
        );
        security.audit(
          current.user.id,
          "comment.replied",
          `thread:${thread.id}`,
        );
      } else if (request.method === "PATCH" && !commentThreadRoute[2]) {
        const resolved = body.resolved === true;
        db.prepare(
          "UPDATE okf_comment_thread SET resolvedAt = ?, resolvedBy = ? WHERE id = ?",
        ).run(
          resolved ? new Date().toISOString() : null,
          resolved ? current.user.id : null,
          thread.id,
        );
        security.audit(
          current.user.id,
          resolved ? "comment.resolved" : "comment.reopened",
          `thread:${thread.id}`,
        );
      } else {
        return Response.json({ error: "Unsupported comment action" }, {
          status: 405,
          headers: cors(request),
        });
      }
      const status = request.method === "PATCH" && body.resolved === true
        ? "resolved"
        : "open";
      const updated = commentThreads(thread.conceptId, status).find((item) =>
        item.id === thread.id
      );
      return Response.json(updated, { headers: cors(request) });
    }
    const revisionRoute = conceptRoute?.[2]?.match(/^revisions\/(\d+)$/);
    if (conceptRoute && revisionRoute && request.method === "GET") {
      const current = await security.session(request);
      if (!current) {
        return new Response("Sign in required", {
          status: 401,
          headers: cors(request),
        });
      }
      const conceptId = conceptRoute[1];
      const row = concept(conceptId);
      if (
        !row || !await security.check(current.user.id, "edit", conceptId)
      ) {
        return new Response("Not found", {
          status: 404,
          headers: cors(request),
        });
      }
      const revision = revisions(conceptId).find((item) =>
        item.number === Number(revisionRoute[1])
      );
      if (!revision) {
        return new Response("Revision not found", {
          status: 404,
          headers: cors(request),
        });
      }
      try {
        return new Response(bodyOnly(await store.get(revision.objectKey)), {
          headers: {
            ...cors(request),
            "content-type": "text/markdown; charset=utf-8",
          },
        });
      } catch (error) {
        return new Response(
          error instanceof Error ? error.message : "Revision unavailable",
          { status: 503, headers: cors(request) },
        );
      }
    }
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
      const parentId = Object.hasOwn(body, "parentId")
        ? body.parentId ? String(body.parentId) : null
        : row.parentId;
      if (
        !title || title.length > 100 ||
        !/^[A-Za-z][A-Za-z0-9 _-]{0,49}$/.test(type) ||
        !DOCUMENT_INTENTS.includes(intent)
      ) {
        return Response.json({
          error: "Title and type are required and must fit their fields",
        }, { status: 400, headers: cors(request) });
      }
      if (parentId) {
        const parent = concept(parentId);
        if (invalidParent(conceptId, parentId)) {
          return Response.json(
            { error: "Documents cannot contain themselves" },
            {
              status: 400,
              headers: cors(request),
            },
          );
        }
        if (
          !parent || parent.spaceId !== spaceId || parent.status !== "active" ||
          !await security.check(current.user.id, "edit", parentId)
        ) {
          return Response.json({ error: "Parent document not found" }, {
            status: 404,
            headers: cors(request),
          });
        }
      }
      if (row.lockedAt) {
        return Response.json({ error: "Unlock the document to change it" }, {
          status: 423,
          headers: cors(request),
        });
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
          "UPDATE okf_concept SET title = ?, type = ?, intent = ?, spaceId = ?, parentId = ?, updatedAt = ? WHERE id = ?",
        ).run(
          title,
          type,
          intent,
          spaceId,
          parentId,
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
        if (error instanceof DocumentLocked) {
          return new Response(error.message, {
            status: 423,
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
        if (action === "lock" || action === "unlock") {
          const locked = action === "lock";
          const now = new Date().toISOString();
          db.prepare(
            "UPDATE okf_concept SET lockedAt = ?, lockedBy = ?, updatedAt = ? WHERE id = ?",
          ).run(
            locked ? now : null,
            locked ? current.user.name : null,
            now,
            conceptId,
          );
          if (locked) {
            (await loadDocument(row)).clients.forEach((client) =>
              client.close(1000, "Document locked")
            );
          }
          security.audit(
            current.user.id,
            locked ? "concept.locked" : "concept.unlocked",
            `concept:${conceptId}`,
          );
          return Response.json(
            await payload(concept(conceptId)!, true, current.user.id),
            { headers: cors(request) },
          );
        }
        if (
          row.lockedAt &&
          (action === "publish" || action.includes("revisions/"))
        ) {
          throw new DocumentLocked("Unlock the document first");
        }
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
          const previous = row.publishedRevision
            ? revisions(conceptId).find((item) =>
              item.number === row.publishedRevision
            )
            : undefined;
          if (previous) {
            const published = await store.get(previous.objectKey);
            const metadata = published.match(
              /^---\r?\n([\s\S]*?)\r?\n---\r?\n/,
            )?.[1] ?? "";
            const sameMetadata = metadata.match(/^type:\s*(.+)$/m)?.[1] ===
                row.type &&
              metadata.match(/^title:\s*(.+)$/m)?.[1] ===
                JSON.stringify(row.title);
            if (sameMetadata && bodyOnly(published) === live.markdown) {
              return Response.json(
                await payload(concept(conceptId)!, true, current.user.id),
                { headers: cors(request) },
              );
            }
          }
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
          security.audit(
            current.user.id,
            "concept.published",
            `concept:${conceptId}:revision:${number}`,
          );
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
          security.audit(
            current.user.id,
            "concept.archived",
            `concept:${conceptId}`,
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
          security.audit(
            current.user.id,
            "concept.restored",
            `concept:${conceptId}`,
          );
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
        const status = error instanceof MarkdownTooLarge
          ? 413
          : error instanceof DocumentLocked
          ? 423
          : 503;
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
      if (row.lockedAt) {
        return new Response("Document is locked", { status: 423 });
      }
      const stale = Number(url.searchParams.get("epoch")) !== row.collabEpoch;
      if (stale) {
        const { socket, response } = Deno.upgradeWebSocket(request);
        socket.addEventListener(
          "open",
          () => socket.close(4009, "Document checkpoint changed"),
        );
        return response;
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
  const port = Number(
    Deno.env.get("OKF_PORT") ?? Deno.env.get("PORT") ?? "8788",
  );
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
  const githubConfig = {
    appId: Deno.env.get("OKF_GITHUB_APP_ID") ?? "",
    slug: Deno.env.get("OKF_GITHUB_APP_SLUG") ?? "",
    privateKey: Deno.env.get("OKF_GITHUB_PRIVATE_KEY") ?? "",
    webhookSecret: Deno.env.get("OKF_GITHUB_WEBHOOK_SECRET") ?? "",
  };
  const githubValues = Object.values(githubConfig).filter(Boolean);
  if (githubValues.length && githubValues.length !== 4) {
    throw new Error("Configure all OKF_GITHUB_APP_* settings or none of them");
  }
  const baseURL = Deno.env.get("OKF_BASE_URL") ??
    Deno.env.get("PORTLESS_URL") ??
    `http://127.0.0.1:${port}`;
  const ssoConfigFile = Deno.env.get("OKF_SSO_CONFIG_FILE")?.trim();
  const ssoConfig = ssoConfigFile ? await Deno.readTextFile(ssoConfigFile) : "";
  const app = await createCollabApp({
    dataDir: Deno.env.get("OKF_DATA_DIR") ?? ".okf-data",
    staticDir: Deno.env.get("OKF_STATIC_DIR") ?? "dist",
    baseURL,
    trustedOrigins: (Deno.env.get("BETTER_AUTH_TRUSTED_ORIGINS") ?? "")
      .split(",").map((origin) => origin.trim()).filter(Boolean),
    authSecret: Deno.env.get("OKF_AUTH_SECRET") ?? undefined,
    openfgaURL: Deno.env.get("OKF_OPENFGA_URL") ?? undefined,
    openfgaKey: Deno.env.get("OKF_OPENFGA_KEY") ?? undefined,
    s3Endpoint: Deno.env.get("OKF_S3_ENDPOINT") ?? undefined,
    s3AccessKey: Deno.env.get("OKF_S3_ACCESS_KEY") ?? undefined,
    s3SecretKey: Deno.env.get("OKF_S3_SECRET_KEY") ?? undefined,
    s3Bucket: Deno.env.get("OKF_S3_BUCKET") ?? undefined,
    automationIntervalMs,
    allowedArtifactHosts,
    githubApp: githubValues.length ? createGitHubAppClient(githubConfig) : null,
    ssoProviders: ssoConfig ? await parseSSOConfig(ssoConfig, baseURL) : [],
    aiProvider: Deno.env.get("OKF_AI_PROVIDER")?.trim(),
    aiModel: Deno.env.get("OKF_AI_MODEL")?.trim(),
    aiURL: Deno.env.get("OKF_AI_URL")?.trim(),
    aiAPIKey: Deno.env.get("OLLAMA_API_KEY")?.trim(),
  });
  Deno.serve({ hostname, port }, app.fetch);
}

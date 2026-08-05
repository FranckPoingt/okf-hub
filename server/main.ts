/// <reference lib="deno.ns" />

import * as Y from "yjs";
import { DatabaseSync } from "node:sqlite";
import { createObjectStore } from "./object-store.ts";
import { CONCEPT, createSecurity } from "./security.ts";

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

function bodyOnly(markdown: string) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?/);
  return match?.[1].match(/^type\s*:/m)
    ? markdown.slice(match[0].length)
    : markdown;
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
  `);
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

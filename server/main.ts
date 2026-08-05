/// <reference lib="deno.ns" />

import * as Y from "yjs";

const DOCUMENT_UPDATE = 0;
const AWARENESS_UPDATE = 1;
const MAX_MARKDOWN_BYTES = 512 * 1024;

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

type AppOptions = { dataDir?: string; staticDir?: string };

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
  return !origin || origin === new URL(request.url).origin || ["http://localhost:3000", "http://127.0.0.1:3000"].includes(origin);
}

function cors(request: Request) {
  return {
    "access-control-allow-origin": request.headers.get("origin") ?? "*",
    "access-control-allow-methods": "GET, PUT, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
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

export async function createCollabApp({ dataDir = ".okf-data", staticDir = "dist" }: AppOptions = {}) {
  await Deno.mkdir(dataDir, { recursive: true });
  const markdownPath = `${dataDir}/incident-communication.md`;
  const statePath = `${dataDir}/incident-communication.yjs`;
  const doc = new Y.Doc();
  const clients = new Set<WebSocket>();

  let markdown: string;
  try {
    markdown = await Deno.readTextFile(markdownPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    markdown = DEFAULT_MARKDOWN;
    await Deno.writeTextFile(markdownPath, markdown);
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

  const fetch = async (request: Request): Promise<Response> => {
    if (!allowedOrigin(request)) return new Response("Origin not allowed", { status: 403 });
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });

    if (url.pathname === "/api/health") {
      return Response.json({ status: "ok", clients: clients.size }, { headers: cors(request) });
    }
    if (url.pathname === "/api/doc" && request.method === "GET") {
      return new Response(markdown, { headers: { ...cors(request), "content-type": "text/markdown; charset=utf-8" } });
    }
    if (url.pathname === "/api/doc" && request.method === "PUT") {
      const next = await request.text();
      if (new TextEncoder().encode(next).byteLength > MAX_MARKDOWN_BYTES) {
        return new Response("Markdown is too large", { status: 413, headers: cors(request) });
      }
      markdown = next.endsWith("\n") ? next : `${next}\n`;
      await Deno.writeTextFile(markdownPath, markdown);
      return new Response(null, { status: 204, headers: cors(request) });
    }
    if (url.pathname === "/collab" && request.headers.get("upgrade") === "websocket") {
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
        if (message[0] === DOCUMENT_UPDATE) Y.applyUpdate(doc, message.subarray(1), socket);
        if (message[0] !== DOCUMENT_UPDATE && message[0] !== AWARENESS_UPDATE) return;
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
      if (decoded.split("/").includes("..")) return new Response("Invalid path", { status: 400 });
      const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
      let path = `${staticDir}/${relative}`;
      let content: Uint8Array;
      try {
        content = await Deno.readFile(path);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound) || !request.headers.get("accept")?.includes("text/html")) {
          return new Response("Not found", { status: 404 });
        }
        path = `${staticDir}/index.html`;
        try {
          content = await Deno.readFile(path);
        } catch {
          return new Response("Build the web app first", { status: 503 });
        }
      }
      const body = request.method === "HEAD"
        ? null
        : content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
      return new Response(body, {
        headers: { "content-type": CONTENT_TYPES[extension(path)] ?? "application/octet-stream" },
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
  });
  Deno.serve({ hostname, port }, app.fetch);
}

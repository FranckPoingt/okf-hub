import { type createActionCatalog } from "./action-catalog.ts";
import type { AuthActor } from "./security.ts";

const VERSIONS = ["2025-06-18", "2025-11-25"];
const MAX_BYTES = 9 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

// Stateless Streamable HTTP: JSON responses, no SSE stream or session IDs.
export function createMcpHandler(
  catalog: ReturnType<typeof createActionCatalog>,
  authenticate: (request: Request) => Promise<AuthActor | null>,
) {
  return async (request: Request): Promise<Response> => {
    const headers = { "Cache-Control": "no-store" };
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) {
      return new Response("Origin not allowed", { status: 403, headers });
    }
    // Remove cookies so a browser session cannot supersede a narrower API key.
    const authHeaders = new Headers(request.headers);
    authHeaders.delete("cookie");
    if (!/^Bearer okf_\S+$/.test(authHeaders.get("authorization") ?? "")) {
      return new Response("Hub API key required", { status: 401, headers });
    }
    const actor = await authenticate(
      new Request(request.url, { headers: authHeaders }),
    );
    if (!actor || actor.via !== "api-key") {
      return new Response("Invalid Hub API key", { status: 401, headers });
    }
    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { ...headers, Allow: "POST" },
      });
    }
    if (
      !request.headers.get("content-type")?.split(";")[0].trim().match(
        /^application\/json$/i,
      )
    ) {
      return new Response("Expected application/json", {
        status: 415,
        headers,
      });
    }
    const accept = request.headers.get("accept") ?? "";
    if (
      !accept.includes("application/json") ||
      !accept.includes("text/event-stream")
    ) {
      return new Response(
        "Accept must include application/json and text/event-stream",
        { status: 406, headers },
      );
    }
    const version = request.headers.get("mcp-protocol-version");
    if (version && !VERSIONS.includes(version)) {
      return new Response("Unsupported MCP protocol version", {
        status: 400,
        headers,
      });
    }
    const reply = (id: unknown, result: unknown) =>
      Response.json({ jsonrpc: "2.0", id, result }, { headers });
    const failure = (
      id: unknown,
      code: number,
      message: string,
      status = 200,
    ) =>
      Response.json({ jsonrpc: "2.0", id, error: { code, message } }, {
        status,
        headers,
      });
    let message: unknown;
    try {
      let size = 0;
      const chunks: Uint8Array[] = [];
      const reader = request.body?.getReader();
      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_BYTES) {
            await reader.cancel();
            return new Response("MCP request exceeds 9 MiB", {
              status: 413,
              headers,
            });
          }
          chunks.push(value);
        }
      }
      message = JSON.parse(await new Blob(chunks as BlobPart[]).text());
    } catch {
      return failure(null, -32700, "Parse error", 400);
    }
    if (
      !record(message) || message.jsonrpc !== "2.0" ||
      typeof message.method !== "string" ||
      (Object.hasOwn(message, "id") && typeof message.id !== "string" &&
        typeof message.id !== "number") ||
      (message.params !== undefined && !record(message.params))
    ) return failure(null, -32600, "Invalid request", 400);
    const id = message.id;
    if (id === undefined) return new Response(null, { status: 202, headers });
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        if (
          typeof params.protocolVersion !== "string" ||
          !record(params.capabilities) || !record(params.clientInfo)
        ) return failure(id, -32602, "Invalid initialize parameters");
        return reply(id, {
          protocolVersion: VERSIONS.includes(params.protocolVersion)
            ? params.protocolVersion
            : VERSIONS.at(-1),
          capabilities: { tools: {} },
          serverInfo: { name: "okf-hub", version: "0.2.0" },
        });
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, {
          tools: catalog.list(actor.scopes).map((action) => ({
            name: action.name,
            title: action.title,
            description: action.description,
            inputSchema: action.inputSchema,
            annotations: {
              readOnlyHint: action.mode === "query",
              openWorldHint: false,
            },
          })),
        });
      case "tools/call": {
        if (
          typeof params.name !== "string" ||
          (params.arguments !== undefined && !record(params.arguments))
        ) return failure(id, -32602, "Invalid tool parameters");
        if (
          !catalog.list(actor.scopes).some((action) =>
            action.name === params.name
          )
        ) return failure(id, -32602, "Unknown tool");
        try {
          const result = await catalog.invoke(
            params.name,
            { userId: actor.user.id, userName: actor.user.name },
            params.arguments ?? {},
            actor.scopes,
          );
          return reply(id, {
            content: [{ type: "text", text: JSON.stringify(result) ?? "null" }],
          });
        } catch (error) {
          const token = authHeaders.get("authorization")!.slice(7);
          const text = (error instanceof Error ? error.message : "Tool failed")
            .split(token).join("[redacted]");
          return reply(id, {
            isError: true,
            content: [{ type: "text", text }],
          });
        }
      }
      default:
        return failure(id, -32601, "Method not found");
    }
  };
}

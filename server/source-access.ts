/// <reference lib="deno.ns" />
import type { createSecurity, SourceAccess } from "./security.ts";

// Owner-only `GET`/`PUT /api/sources/:id/access`. Enforcement lives entirely in
// the imported space's OpenFGA tuples; this only validates and applies them.
export function createSourceAccessRoutes(
  { security, sourceExists, conceptIds }: {
    security: Pick<
      Awaited<ReturnType<typeof createSecurity>>,
      | "session"
      | "isOwner"
      | "sourceAccess"
      | "setSourceAccess"
      | "ensureImportedConcept"
    >;
    sourceExists: (id: string) => boolean;
    conceptIds: (id: string) => string[];
  },
) {
  return async function handle(request: Request, sourceId: string) {
    const current = await security.session(request);
    if (!current) {
      return Response.json({ error: "Sign in required" }, { status: 401 });
    }
    if (!security.isOwner(current.user.id)) {
      return Response.json({ error: "Owner access required" }, {
        status: 403,
      });
    }
    if (!sourceExists(sourceId)) {
      return Response.json({ error: "Source not found" }, { status: 404 });
    }
    if (request.method === "GET") {
      return Response.json(security.sourceAccess(sourceId));
    }
    const body = await request.json().catch(() => ({})) as Partial<
      SourceAccess
    >;
    if (
      (body.mode !== "workspace" && body.mode !== "restricted") ||
      !Array.isArray(body.grants ?? []) || (body.grants?.length ?? 0) > 45
    ) {
      return Response.json({ error: "Choose who can access this source" }, {
        status: 400,
      });
    }
    try {
      // Concepts imported before per-source spaces must inherit the new access.
      for (const id of conceptIds(sourceId)) {
        await security.ensureImportedConcept(sourceId, id);
      }
      return Response.json(
        await security.setSourceAccess(current.user.id, sourceId, {
          mode: body.mode,
          grants: (body.grants ?? []).map((grant) => ({
            type: grant?.type,
            id: String(grant?.id ?? ""),
            role: grant?.role,
          })),
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return message === "Choose workspace members or groups"
        ? Response.json({ error: message }, { status: 400 })
        : Response.json({ error: "Access update failed" }, { status: 503 });
    }
  };
}

import {
  type ActionContext,
  type ActionDefinition,
  ActionError,
  type createActionCatalog,
} from "./action-catalog.ts";
import {
  type BundleFile,
  MAX_BYTES,
  MAX_FILES,
  PREFIX,
  sha256,
} from "./artifact-bundle.ts";
import type { AIMessage } from "./ai.ts";

const objectSchema = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const text = { type: "string" };
export function agentActions(deps: {
  catalog: () => ReturnType<typeof createActionCatalog>;
  appState: (userId: string, documentId: string) => Promise<{
    apps: ({ id: string; version: number; bundle?: unknown } | null)[];
  }>;
  readBundle: (appId: string, version: number) => string | undefined;
  relationships: (userId: string, id: string) => Promise<unknown>;
  ask?: (userId: string, messages: AIMessage[]) => Promise<unknown>;
  suggest: (
    context: ActionContext,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
}): ActionDefinition[] {
  const query = { mode: "query", approval: "none" } as const;
  return [
    {
      ...query,
      name: "artifact.get",
      tag: "Apps",
      title: "Get artifact",
      description:
        "Read the visible artifact context and selected App bundle. Editors see drafts; readers see activated files. Specify appId if the document has multiple Apps.",
      requiredScopes: ["documents.get"],
      inputSchema: objectSchema({ documentId: text, appId: text }, [
        "documentId",
      ]),
      outputSchema: objectSchema({
        context: { type: "object" },
        files: { type: "object" },
        version: { type: "number" },
        appId: text,
        digest: text,
      }),
      run: async (context, input) => {
        const documentId = String(input.documentId);
        const document = await deps.catalog().invoke("documents.get", context, {
          id: documentId,
        }, context.scopes);
        const state = await deps.appState(context.userId, documentId);
        const apps = state.apps.filter((app) =>
          app && app.bundle && (!input.appId || app.id === input.appId)
        );
        if (apps.length !== 1) {
          throw new ActionError(
            apps.length ? "Choose an appId" : "Artifact not found",
            apps.length ? 400 : 404,
          );
        }
        const app = apps[0]!;
        const content = deps.readBundle(app.id, app.version);
        if (!content?.startsWith(PREFIX)) {
          throw new ActionError("Artifact not found", 404);
        }
        if (new TextEncoder().encode(content).length > MAX_BYTES) {
          throw new ActionError("Artifact exceeds 8 MiB", 413);
        }
        const bundle = JSON.parse(content.slice(PREFIX.length)) as {
          files: BundleFile[];
        };
        if (bundle.files.length > MAX_FILES) {
          throw new ActionError("Artifact exceeds 200 files", 413);
        }
        return {
          context: document,
          files: Object.fromEntries(
            bundle.files.map((
              file,
            ) => [file.path, { type: file.type, data: file.data }]),
          ),
          version: app.version,
          appId: app.id,
          digest: await sha256(new TextEncoder().encode(content)),
        };
      },
    },
    ...(deps.ask
      ? [{
        ...query,
        name: "knowledge.ask",
        tag: "Knowledge" as const,
        title: "Ask OKF",
        description:
          "Answer a workspace question using permission-filtered retrieval, query rewriting and numbered source citations.",
        inputSchema: objectSchema({
          question: { type: "string", maxLength: 4000 },
        }),
        outputSchema: objectSchema({
          answer: text,
          citations: { type: "array", items: { type: "object" } },
        }),
        run: (context: ActionContext, input: Record<string, unknown>) => {
          const question = String(input.question).trim();
          if (!question) throw new ActionError("Question is required");
          return deps.ask!(context.userId, [{
            role: "user",
            content: question,
          }]);
        },
      }]
      : []),
    {
      ...query,
      name: "knowledge.relationships",
      tag: "Knowledge",
      title: "Get knowledge relationships",
      description:
        "Read links, backlinks, shared definitions, conflicts, trust and freshness from the caller's visible knowledge graph.",
      inputSchema: objectSchema({ id: text }),
      outputSchema: {
        type: "object",
        properties: {
          links: { type: "array" },
          backlinks: { type: "array" },
          alsoDefinedIn: { type: "array" },
          conflicts: { type: "array" },
          trust: text,
          trustReason: text,
          freshness: { type: "object" },
        },
      },
      run: (context, input) =>
        deps.relationships(context.userId, String(input.id)),
    },
    {
      name: "sources.suggest-change",
      tag: "Sources",
      title: "Suggest a source change",
      description:
        "Suggest an imported Git concept edit at its base revision. Creates a GitHub App PR or returns a patch for manual sources.",
      mode: "mutation",
      approval: "confirm",
      inputSchema: objectSchema({
        sourceId: text,
        path: text,
        baseRevision: text,
        body: { type: "string", maxLength: 512 * 1024 },
        rationale: { type: "string", maxLength: 1000 },
      }),
      outputSchema: { type: "object", properties: { url: text, patch: text } },
      run: deps.suggest,
    },
  ];
}

export type JsonSchema = Record<string, unknown>;

export type ActionContext = {
  userId: string;
  userName: string;
};

export type ActionDefinition = {
  name: string;
  tag:
    | "Knowledge"
    | "Documents"
    | "Templates"
    | "Sources"
    | "Apps"
    | "App data";
  title: string;
  description: string;
  mode: "query" | "mutation";
  approval: "none" | "confirm";
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  run: (context: ActionContext, input: Record<string, unknown>) => unknown;
};

export class ActionError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function schemaError(
  schema: JsonSchema,
  value: unknown,
  path = "input",
): string | null {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${path} must be one of ${schema.enum.join(", ")}`;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return `${path} must be a string`;
    if (
      typeof schema.maxLength === "number" && value.length > schema.maxLength
    ) {
      return `${path} is too long`;
    }
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    return `${path} must be a boolean`;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return `${path} has too many items`;
    }
    if (schema.items && typeof schema.items === "object") {
      for (let index = 0; index < value.length; index++) {
        const error = schemaError(
          schema.items as JsonSchema,
          value[index],
          `${path}[${index}]`,
        );
        if (error) return error;
      }
    }
  }
  if (schema.type === "object") {
    if (!value || Array.isArray(value) || typeof value !== "object") {
      return `${path} must be an object`;
    }
    const record = value as Record<string, unknown>;
    const properties =
      schema.properties && typeof schema.properties === "object"
        ? schema.properties as Record<string, JsonSchema>
        : {};
    for (
      const required of Array.isArray(schema.required) ? schema.required : []
    ) {
      if (typeof required === "string" && !Object.hasOwn(record, required)) {
        return `${path}.${required} is required`;
      }
    }
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(record).find((key) =>
        !Object.hasOwn(properties, key)
      );
      if (unknown) return `${path}.${unknown} is not allowed`;
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!Object.hasOwn(record, key)) continue;
      const error = schemaError(propertySchema, record[key], `${path}.${key}`);
      if (error) return error;
    }
  }
  return null;
}

export function actionAllowed(scopes: string[], name: string) {
  return scopes.some((scope) =>
    scope === "*" || scope === name ||
    (scope.endsWith(".*") && name.startsWith(scope.slice(0, -1)))
  );
}

export function createActionCatalog(definitions: ActionDefinition[]) {
  const actions = new Map(definitions.map((action) => [action.name, action]));
  if (actions.size !== definitions.length) {
    throw new Error("Action names must be unique");
  }
  const describe = (action: ActionDefinition) => ({
    name: action.name,
    tag: action.tag,
    title: action.title,
    description: action.description,
    mode: action.mode,
    approval: action.approval,
    inputSchema: action.inputSchema,
    outputSchema: action.outputSchema,
  });
  return {
    list(scopes = ["*"]) {
      return definitions.filter((action) => actionAllowed(scopes, action.name))
        .map(describe);
    },
    async invoke(
      name: string,
      context: ActionContext,
      input: Record<string, unknown>,
      scopes = ["*"],
    ) {
      const action = actions.get(name);
      if (!action || !actionAllowed(scopes, name)) {
        throw new ActionError("Action not found", 404);
      }
      const error = schemaError(action.inputSchema, input);
      if (error) throw new ActionError(error);
      return await action.run(context, input);
    },
    openApi(basePath = "/api/v1/actions") {
      return {
        openapi: "3.1.0",
        info: {
          title: "OKF Hub developer API",
          version: "0.1.0",
          description:
            "Permission-filtered operations over portable OKF knowledge.",
        },
        tags: [
          { name: "Knowledge", description: "Find accessible knowledge." },
          { name: "Documents", description: "Create and manage documents." },
          { name: "Templates", description: "Reuse document structures." },
          { name: "Sources", description: "Inspect connected sources." },
          { name: "Apps", description: "Manage governed document Apps." },
          { name: "App data", description: "Read and write App-owned data." },
        ],
        paths: Object.fromEntries(definitions.map((action) => [
          `${basePath}/${action.name}`,
          {
            post: {
              operationId: action.name,
              tags: [action.tag],
              summary: action.title,
              description: action.description,
              security: [{ bearerAuth: [] }, { cookieAuth: [] }],
              requestBody: {
                required: true,
                content: {
                  "application/json": { schema: action.inputSchema },
                },
              },
              responses: {
                "200": {
                  description: "Successful action result",
                  content: {
                    "application/json": {
                      schema: action.outputSchema ?? {},
                    },
                  },
                },
              },
            },
          },
        ])),
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer" },
            cookieAuth: {
              type: "apiKey",
              in: "cookie",
              name: "better-auth.session_token",
            },
          },
        },
      };
    },
  };
}

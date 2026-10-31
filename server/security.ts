/// <reference lib="deno.ns" />

import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { magicLink, organization } from "better-auth/plugins";
import { runWithAdapter } from "@better-auth/core/context";
import { sso } from "@better-auth/sso";
import type { ConfiguredSSOProvider } from "./sso-config.ts";

type Session = Awaited<
  ReturnType<ReturnType<typeof betterAuth>["api"]["getSession"]>
>;
type Row = Record<string, unknown>;
export type SourceGrant = {
  type: "user" | "group";
  id: string;
  role: "viewer" | "editor";
};
export type SourceAccess = {
  mode: "workspace" | "restricted";
  grants: SourceGrant[];
};
export type AuthActor = {
  user: { id: string; name: string; email: string };
  scopes: string[];
  via: "session" | "api-key";
};

const SOURCE = "company";
// Host-operator actions (CLI, startup bootstrap) are audited under this actor.
export const HOST_OPERATOR = "host-operator";
const LOGIN_LINK_SECONDS = 15 * 60;
const SPACE = "policies";
const IMPORTED_SPACE = "imported";
export const CONCEPT = "incident-communication";

// Bump when `model` changes; existing stores get a new model version.
const MODEL_VERSION = 3;

const model = {
  schema_version: "1.1",
  type_definitions: [
    { type: "user" },
    {
      type: "group",
      relations: { member: { this: {} } },
      metadata: {
        relations: {
          member: { directly_related_user_types: [{ type: "user" }] },
        },
      },
    },
    {
      type: "source",
      relations: {
        owner: { this: {} },
        editor: { this: {} },
        viewer: { this: {} },
        edit: {
          union: {
            child: [{ computedUserset: { relation: "owner" } }, {
              computedUserset: { relation: "editor" },
            }],
          },
        },
        view: {
          union: {
            child: [{ computedUserset: { relation: "owner" } }, {
              computedUserset: { relation: "editor" },
            }, { computedUserset: { relation: "viewer" } }],
          },
        },
      },
      metadata: {
        relations: {
          owner: { directly_related_user_types: [{ type: "user" }] },
          editor: {
            directly_related_user_types: [{
              type: "group",
              relation: "member",
            }],
          },
          viewer: {
            directly_related_user_types: [{
              type: "group",
              relation: "member",
            }],
          },
        },
      },
    },
    {
      type: "space",
      relations: {
        parent: { this: {} },
        // Restricted sources drop `parent` and keep only workspace owners.
        workspace: { this: {} },
        manager: { this: {} },
        editor: { this: {} },
        viewer: { this: {} },
        manage: { computedUserset: { relation: "manager" } },
        edit: {
          union: {
            child: [{ computedUserset: { relation: "manager" } }, {
              computedUserset: { relation: "editor" },
            }, {
              tupleToUserset: {
                tupleset: { relation: "parent" },
                computedUserset: { relation: "edit" },
              },
            }, {
              tupleToUserset: {
                tupleset: { relation: "workspace" },
                computedUserset: { relation: "owner" },
              },
            }],
          },
        },
        view: {
          union: {
            child: [{ computedUserset: { relation: "manager" } }, {
              computedUserset: { relation: "editor" },
            }, {
              computedUserset: { relation: "viewer" },
            }, {
              tupleToUserset: {
                tupleset: { relation: "parent" },
                computedUserset: { relation: "view" },
              },
            }, {
              tupleToUserset: {
                tupleset: { relation: "workspace" },
                computedUserset: { relation: "owner" },
              },
            }],
          },
        },
      },
      metadata: {
        relations: {
          parent: { directly_related_user_types: [{ type: "source" }] },
          workspace: { directly_related_user_types: [{ type: "source" }] },
          manager: { directly_related_user_types: [{ type: "user" }] },
          editor: {
            directly_related_user_types: [{ type: "user" }, {
              type: "group",
              relation: "member",
            }],
          },
          viewer: {
            directly_related_user_types: [{ type: "user" }, {
              type: "group",
              relation: "member",
            }],
          },
        },
      },
    },
    {
      type: "concept",
      relations: {
        parent: { this: {} },
        edit: {
          tupleToUserset: {
            tupleset: { relation: "parent" },
            computedUserset: { relation: "edit" },
          },
        },
        view: {
          tupleToUserset: {
            tupleset: { relation: "parent" },
            computedUserset: { relation: "view" },
          },
        },
      },
      metadata: {
        relations: {
          parent: { directly_related_user_types: [{ type: "space" }] },
        },
      },
    },
  ],
};

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function randomToken(bytes = 32) {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function secret(dataDir: string, configured?: string) {
  if (configured) return configured;
  const path = `${dataDir}/auth-secret`;
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    const value = Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    await Deno.writeTextFile(path, value, { mode: 0o600 });
    return value;
  }
}

export async function createSecurity({
  dataDir,
  baseURL = "http://127.0.0.1:8788",
  authSecret,
  openfgaURL = "http://127.0.0.1:8080",
  openfgaKey,
  trustedOrigins = [],
  ssoProviders = [],
  requireSetupToken = false,
}: {
  dataDir: string;
  baseURL?: string;
  authSecret?: string;
  openfgaURL?: string;
  openfgaKey?: string;
  trustedOrigins?: string[];
  ssoProviders?: ConfiguredSSOProvider[];
  // Production entry points set this; tests create the first account freely.
  requireSetupToken?: boolean;
}) {
  const db = new DatabaseSync(`${dataDir}/hub.db`);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  const get = (key: string) =>
    (db.prepare("SELECT value FROM okf_config WHERE key = ?").get(key) as
      | Row
      | undefined)?.value as string | undefined;
  const authSecretValue = await secret(dataDir, authSecret);
  // Emails allowed past the signup gate: a valid setup token or a host operator.
  const allowedSignups = new Set<string>();
  let capturedLoginLink = "";
  const authHost = new URL(baseURL).hostname;
  const localCookieDomain = authHost === "okf-hub.localhost"
    ? "okf-hub.localhost"
    : undefined;
  const auth = betterAuth({
    baseURL,
    secret: authSecretValue,
    secrets: [{ version: 1, value: authSecretValue }],
    trustedOrigins: [
      baseURL,
      "http://127.0.0.1:3000",
      "http://localhost:3000",
      ...trustedOrigins,
    ],
    database: db,
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    databaseHooks: {
      user: {
        create: {
          before: (user) => {
            if (allowedSignups.has(user.email.toLowerCase())) {
              return Promise.resolve();
            }
            if (!get("organization_id")) {
              if (!requireSetupToken) return Promise.resolve();
              throw new APIError("FORBIDDEN", {
                message:
                  "Open the setup link from the server logs to create the first account",
              });
            }
            const invited = db.prepare(
              "SELECT 1 FROM invitation WHERE lower(email) = lower(?) AND status = 'pending'",
            ).get(user.email);
            if (!invited) {
              throw new APIError("FORBIDDEN", {
                message:
                  "A workspace invitation is required to create an account",
              });
            }
            return Promise.resolve();
          },
        },
      },
    },
    advanced: localCookieDomain
      ? {
        crossSubDomainCookies: {
          enabled: true,
          domain: localCookieDomain,
        },
      }
      : undefined,
    telemetry: { enabled: false },
    plugins: [
      organization({ teams: { enabled: true } }),
      // Links are only minted by the host operator; the request route is blocked in handle().
      magicLink({
        expiresIn: LOGIN_LINK_SECONDS,
        disableSignUp: true,
        storeToken: "hashed",
        sendMagicLink: ({ url }) => {
          capturedLoginLink = url;
        },
      }),
      ...(ssoProviders.length
        ? [sso({ defaultSSO: ssoProviders.map((provider) => provider.auth) })]
        : []),
    ],
  });
  const authContext = await auth.$context;
  const authCall = <T>(call: () => Promise<T>) =>
    runWithAdapter(authContext.adapter, call);
  await (await getMigrations(auth.options)).runMigrations();
  db.exec(`
    CREATE TABLE IF NOT EXISTS okf_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS okf_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurredAt TEXT NOT NULL,
      actorUserId TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS okf_invite_delivery (
      invitationId TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      access TEXT NOT NULL,
      url TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS okf_api_key (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      name TEXT NOT NULL,
      tokenHash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      scopes TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      expiresAt TEXT,
      lastUsedAt TEXT,
      revokedAt TEXT,
      FOREIGN KEY (userId) REFERENCES user(id)
    );
  `);

  const set = (key: string, value: string) =>
    db.prepare(
      "INSERT INTO okf_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  const unset = (key: string) =>
    db.prepare("DELETE FROM okf_config WHERE key = ?").run(key);
  if (get("organization_id")) {
    set(`openfga_hub_space:${SPACE}`, "1");
    set(`openfga_hub_concept:${CONCEPT}`, "1");
  }
  const audit = (actorUserId: string, action: string, target: string) =>
    db.prepare(
      "INSERT INTO okf_audit (occurredAt, actorUserId, action, target) VALUES (?, ?, ?, ?)",
    ).run(new Date().toISOString(), actorUserId, action, target);
  const activity = (target: string) =>
    db.prepare(
      `SELECT audit.occurredAt, audit.actorUserId, actor.name AS actorName,
              audit.action, audit.target
       FROM okf_audit audit
       LEFT JOIN user actor ON actor.id = audit.actorUserId
       WHERE audit.target = ? OR audit.target LIKE ?
       ORDER BY audit.id DESC
       LIMIT 100`,
    ).all(target, `${target}:%`);
  const session = (request: Request) =>
    authCall(() => auth.api.getSession({ headers: request.headers }));

  async function tokenHash(token: string) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(token),
    );
    return Array.from(
      new Uint8Array(digest),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  }

  async function authenticate(request: Request): Promise<AuthActor | null> {
    const current = await session(request);
    if (current) {
      return {
        user: current.user,
        scopes: ["*"],
        via: "session",
      };
    }
    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : "";
    if (!token.startsWith("okf_")) return null;
    const row = db.prepare(
      `SELECT k.id, k.userId, k.scopes, k.expiresAt, user.name, user.email
       FROM okf_api_key k JOIN "user" user ON user.id = k.userId
       WHERE k.tokenHash = ? AND k.revokedAt IS NULL`,
    ).get(await tokenHash(token)) as Row | undefined;
    if (
      !row ||
      (row.expiresAt && String(row.expiresAt) <= new Date().toISOString())
    ) {
      return null;
    }
    db.prepare("UPDATE okf_api_key SET lastUsedAt = ? WHERE id = ?").run(
      new Date().toISOString(),
      String(row.id),
    );
    return {
      user: {
        id: String(row.userId),
        name: String(row.name),
        email: String(row.email),
      },
      scopes: JSON.parse(String(row.scopes)) as string[],
      via: "api-key",
    };
  }

  function apiKeys(userId: string) {
    return db.prepare(
      "SELECT id, name, prefix, scopes, createdAt, expiresAt, lastUsedAt, revokedAt FROM okf_api_key WHERE userId = ? ORDER BY createdAt DESC",
    ).all(userId).map((row) => ({
      ...row,
      scopes: JSON.parse(String((row as Row).scopes)) as string[],
    }));
  }

  async function createApiKey(
    userId: string,
    name: string,
    scopes: string[],
    expiresAt?: string,
  ) {
    const cleanName = name.trim();
    const cleanScopes = Array.from(new Set(scopes.map((scope) => scope.trim())))
      .filter(Boolean);
    if (!cleanName || cleanName.length > 80) {
      throw new Error("API key name must be 1–80 characters");
    }
    if (
      !cleanScopes.length ||
      cleanScopes.some((scope) =>
        !/^(?:\*|[a-z][a-z0-9-]*(?:\.[a-z0-9*-]+)+)$/.test(scope)
      )
    ) {
      throw new Error("Choose valid action scopes");
    }
    if (
      expiresAt &&
      (!Number.isFinite(Date.parse(expiresAt)) ||
        expiresAt <= new Date().toISOString())
    ) {
      throw new Error("Expiry must be a future ISO date");
    }
    const token = `okf_${
      Array.from(
        crypto.getRandomValues(new Uint8Array(32)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("")
    }`;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO okf_api_key (id, userId, name, tokenHash, prefix, scopes, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      userId,
      cleanName,
      await tokenHash(token),
      token.slice(0, 12),
      JSON.stringify(cleanScopes),
      now,
      expiresAt || null,
    );
    audit(userId, "api_key.created", `api_key:${id}`);
    return {
      id,
      name: cleanName,
      token,
      prefix: token.slice(0, 12),
      scopes: cleanScopes,
      createdAt: now,
      expiresAt: expiresAt || null,
    };
  }

  async function fga(path: string, init: RequestInit) {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (openfgaKey) headers.set("authorization", `Bearer ${openfgaKey}`);
    const response = await fetch(`${openfgaURL}${path}`, { ...init, headers });
    if (!response.ok) {
      throw new Error(`OpenFGA ${response.status}: ${await response.text()}`);
    }
    return response.status === 204 ? {} : await response.json();
  }

  async function authorization() {
    let storeId = get("openfga_store_id");
    let modelId = get("openfga_model_id");
    if (!storeId) {
      const result = await fga("/stores", {
        method: "POST",
        body: JSON.stringify({ name: "OKF Hub" }),
      }) as Row;
      storeId = String(result.id);
      set("openfga_store_id", storeId);
    }
    if (!modelId || Number(get("openfga_model_version") ?? 1) < MODEL_VERSION) {
      const result = await fga(`/stores/${storeId}/authorization-models`, {
        method: "POST",
        body: JSON.stringify(model),
      }) as Row;
      modelId = String(result.authorization_model_id);
      set("openfga_model_id", modelId);
      set("openfga_model_version", String(MODEL_VERSION));
    }
    return { storeId, modelId };
  }

  async function writeTuples(
    tupleKeys: { user: string; relation: string; object: string }[],
  ) {
    const { storeId, modelId } = await authorization();
    await fga(`/stores/${storeId}/write`, {
      method: "POST",
      body: JSON.stringify({
        writes: { tuple_keys: tupleKeys },
        authorization_model_id: modelId,
      }),
    });
  }

  async function checkObject(
    userId: string,
    relation: "view" | "edit" | "manage",
    object: string,
  ) {
    const { storeId, modelId } = await authorization();
    const result = await fga(`/stores/${storeId}/check`, {
      method: "POST",
      body: JSON.stringify({
        tuple_key: {
          user: `user:${userId}`,
          relation,
          object,
        },
        authorization_model_id: modelId,
      }),
    }) as Row;
    return result.allowed === true;
  }

  function check(
    userId: string,
    relation: "view" | "edit",
    conceptId = CONCEPT,
  ) {
    return checkObject(userId, relation, `concept:${conceptId}`);
  }

  function checkSpace(
    userId: string,
    relation: "view" | "edit" | "manage",
    spaceId: string,
  ) {
    return checkObject(userId, relation, `space:${spaceId}`);
  }

  function member(userId: string) {
    return db.prepare(
      "SELECT id, organizationId, role FROM member WHERE userId = ? ORDER BY createdAt LIMIT 1",
    ).get(userId) as Row | undefined;
  }

  function isOwner(userId: string) {
    return String(member(userId)?.role ?? "").split(",").includes("owner");
  }

  function findUser(email: string) {
    return db.prepare(
      'SELECT id, name, email FROM "user" WHERE lower(email) = lower(?)',
    ).get(email.trim()) as Row | undefined;
  }

  // Signup without an invitation needs this token until the first account exists.
  function setupURL() {
    if (
      !requireSetupToken || get("organization_id") ||
      db.prepare('SELECT 1 FROM "user" LIMIT 1').get()
    ) return null;
    db.prepare(
      "INSERT INTO okf_config (key, value) VALUES ('setup_token', ?) ON CONFLICT(key) DO NOTHING",
    ).run(randomToken());
    return `${baseURL}/?setup=${get("setup_token")}`;
  }

  // Returns false when the user already has the requested ownership.
  async function setOwner(userId: string, enabled: boolean) {
    const organizationId = get("organization_id");
    if (!organizationId) throw new Error("Finish workspace setup first");
    const membership = member(userId);
    const roles = String(membership?.role ?? "").split(",").filter(Boolean);
    if (roles.includes("owner") === enabled) return false;
    const owners = (db.prepare(
      "SELECT role FROM member WHERE organizationId = ?",
    ).all(organizationId) as Row[]).filter((row) =>
      String(row.role).split(",").includes("owner")
    ).length;
    if (!enabled && owners <= 1) {
      throw new Error("The workspace must keep at least one owner");
    }
    const ownerTuple = {
      user: `user:${userId}`,
      relation: "owner",
      object: `source:${SOURCE}`,
    };
    if (enabled) {
      await writeTuples([ownerTuple]);
      if (!membership) {
        await authCall(() =>
          auth.api.addMember({
            body: { userId, organizationId, role: "owner" },
          })
        );
        return true;
      }
    } else {
      // Former owners keep editor access instead of losing the workspace.
      const editorTeamId = get("editor_team_id");
      const joinEditors = editorTeamId &&
        !db.prepare("SELECT 1 FROM teamMember WHERE userId = ? AND teamId = ?")
          .get(userId, editorTeamId);
      const { storeId, modelId } = await authorization();
      await fga(`/stores/${storeId}/write`, {
        method: "POST",
        body: JSON.stringify({
          ...(joinEditors
            ? {
              writes: {
                tuple_keys: [{
                  user: `user:${userId}`,
                  relation: "member",
                  object: `group:${editorTeamId}`,
                }],
              },
            }
            : {}),
          deletes: { tuple_keys: [ownerTuple] },
          authorization_model_id: modelId,
        }),
      });
      if (joinEditors) {
        await authCall(() =>
          authContext.adapter.create({
            model: "teamMember",
            data: { teamId: editorTeamId, userId, createdAt: new Date() },
          })
        );
      }
    }
    const role = enabled
      ? [...roles, "owner"]
      : roles.filter((item) => item !== "owner");
    await authCall(() =>
      authContext.adapter.update({
        model: "member",
        where: [{ field: "id", value: String(membership!.id) }],
        update: { role: role.join(",") || "member" },
      })
    );
    return true;
  }

  // Host-only operations for server/admin.ts. Never route these from handle().
  const operator = {
    findUser,
    workspaceReady: () => Boolean(get("organization_id")),
    users: () =>
      (db.prepare(
        `SELECT u.id, u.name, u.email, u.createdAt, m.role
         FROM "user" u LEFT JOIN member m ON m.userId = u.id
         ORDER BY u.createdAt`,
      ).all() as Row[]).map((row) => ({
        id: String(row.id),
        name: String(row.name),
        email: String(row.email),
        owner: String(row.role ?? "").split(",").includes("owner"),
        createdAt: new Date(row.createdAt as string).toISOString(),
      })),
    async createAccount(email: string, name = "") {
      const clean = email.trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(clean)) throw new Error("Enter a valid email");
      if (findUser(clean)) throw new Error(`${clean} already has an account`);
      allowedSignups.add(clean);
      try {
        const user = await authCall(() =>
          authContext.internalAdapter.createUser({
            email: clean,
            name: name.trim() || clean.split("@")[0],
            emailVerified: true,
          })
        );
        return String(user.id);
      } finally {
        allowedSignups.delete(clean);
      }
    },
    async resetPassword(userId: string) {
      const password = randomToken(16);
      const hash = await authContext.password.hash(password);
      await authCall(async () => {
        const adapter = authContext.internalAdapter;
        const accounts = await adapter.findAccounts(userId);
        if (accounts.some((account) => account.providerId === "credential")) {
          await adapter.updatePassword(userId, hash);
        } else {
          await adapter.linkAccount({
            userId,
            providerId: "credential",
            accountId: userId,
            password: hash,
          });
        }
        // The operator vouches for the address, so login links keep this password.
        await adapter.updateUser(userId, { emailVerified: true });
        await adapter.deleteUserSessions(userId);
      });
      set(`password_change:${userId}`, "1");
      return password;
    },
    async loginLink(email: string) {
      capturedLoginLink = "";
      await authCall(() =>
        auth.api.signInMagicLink({
          body: { email: email.trim().toLowerCase(), callbackURL: "/" },
          headers: new Headers(),
        })
      );
      if (!capturedLoginLink) throw new Error("Login link was not created");
      return capturedLoginLink;
    },
  };

  async function setup(
    current: NonNullable<Session>,
    headers: Headers,
    name: string,
    tagline: string,
  ) {
    let org = db.prepare(
      'SELECT id FROM "organization" ORDER BY createdAt LIMIT 1',
    ).get() as Row | undefined;
    if (!org) {
      const slug = name.toLowerCase().normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
      org = await authCall(() =>
        auth.api.createOrganization({
          headers,
          body: { name, slug },
        })
      ) as Row;
    }
    const organizationId = String(org.id);
    if (!isOwner(current.user.id)) {
      throw new Error("Only the organization owner can finish setup");
    }

    const ensureTeam = async (name: string) => {
      const existing = db.prepare(
        "SELECT id FROM team WHERE organizationId = ? AND name = ?",
      ).get(organizationId, name) as Row | undefined;
      if (existing) return String(existing.id);
      const created = await authCall(() =>
        auth.api.createTeam({
          headers,
          body: { name, organizationId },
        })
      ) as Row;
      return String(created.id);
    };
    const editorTeamId = await ensureTeam("Policy editors");
    const viewerTeamId = await ensureTeam("Policy viewers");
    const firstSetup = !get("organization_id");
    set("organization_id", organizationId);
    set("editor_team_id", editorTeamId);
    set("viewer_team_id", viewerTeamId);
    set("workspace_name", name);
    tagline ? set("workspace_tagline", tagline) : unset("workspace_tagline");
    await writeTuples([
      {
        user: `user:${current.user.id}`,
        relation: "owner",
        object: `source:${SOURCE}`,
      },
      {
        user: `group:${editorTeamId}#member`,
        relation: "editor",
        object: `source:${SOURCE}`,
      },
      {
        user: `group:${viewerTeamId}#member`,
        relation: "viewer",
        object: `space:${SPACE}`,
      },
      {
        user: `source:${SOURCE}`,
        relation: "parent",
        object: `space:${SPACE}`,
      },
      {
        user: `space:${SPACE}`,
        relation: "parent",
        object: `concept:${CONCEPT}`,
      },
      {
        user: `source:${SOURCE}`,
        relation: "parent",
        object: `space:${IMPORTED_SPACE}`,
      },
      {
        user: `group:${viewerTeamId}#member`,
        relation: "viewer",
        object: `space:${IMPORTED_SPACE}`,
      },
    ]);
    set(`openfga_hub_space:${SPACE}`, "1");
    set(`openfga_hub_concept:${CONCEPT}`, "1");
    set("openfga_imported_space", "1");
    if (firstSetup) {
      audit(
        current.user.id,
        "organization.created",
        `organization:${organizationId}`,
      );
    }
  }

  async function ensureHubSpace(spaceId: string) {
    const key = `openfga_hub_space:${spaceId}`;
    if (get(key)) return;
    const viewerTeamId = get("viewer_team_id");
    if (!viewerTeamId) throw new Error("Finish organization setup first");
    await writeTuples([{
      user: `source:${SOURCE}`,
      relation: "parent",
      object: `space:${spaceId}`,
    }, {
      user: `group:${viewerTeamId}#member`,
      relation: "viewer",
      object: `space:${spaceId}`,
    }]);
    set(key, "1");
  }

  async function ensureHubConcept(conceptId: string, spaceId: string) {
    const key = `openfga_hub_concept:${conceptId}`;
    if (get(key)) return;
    await ensureHubSpace(spaceId);
    await writeTuples([{
      user: `space:${spaceId}`,
      relation: "parent",
      object: `concept:${conceptId}`,
    }]);
    set(key, "1");
  }

  async function moveHubConcept(
    conceptId: string,
    fromSpaceId: string,
    toSpaceId: string,
  ) {
    if (fromSpaceId === toSpaceId) return;
    await ensureHubSpace(toSpaceId);
    const { storeId, modelId } = await authorization();
    await fga(`/stores/${storeId}/write`, {
      method: "POST",
      body: JSON.stringify({
        writes: {
          tuple_keys: [{
            user: `space:${toSpaceId}`,
            relation: "parent",
            object: `concept:${conceptId}`,
          }],
        },
        deletes: {
          tuple_keys: [{
            user: `space:${fromSpaceId}`,
            relation: "parent",
            object: `concept:${conceptId}`,
          }],
        },
        authorization_model_id: modelId,
      }),
    });
  }

  async function setSpaceManager(
    spaceId: string,
    userId: string,
    enabled: boolean,
  ) {
    const key = `space_manager:${spaceId}:${userId}`;
    const tuple = {
      user: `user:${userId}`,
      relation: "manager",
      object: `space:${spaceId}`,
    };
    if (enabled) {
      await ensureHubSpace(spaceId);
      await writeTuples([tuple]);
      set(key, "1");
    } else {
      const { storeId, modelId } = await authorization();
      await fga(`/stores/${storeId}/write`, {
        method: "POST",
        body: JSON.stringify({
          deletes: { tuple_keys: [tuple] },
          authorization_model_id: modelId,
        }),
      });
      unset(key);
    }
  }

  function spaceManagers(spaceId: string) {
    const prefix = `space_manager:${spaceId}:`;
    return (db.prepare(
      "SELECT key FROM okf_config WHERE substr(key, 1, ?) = ? ORDER BY key",
    ).all(prefix.length, prefix) as Row[])
      .map((row) => String(row.key).slice(prefix.length)).filter(hasMember);
  }

  function hasMember(userId: string) {
    return Boolean(member(userId));
  }

  async function deleteHubSpace(spaceId: string) {
    const viewerTeamId = get("viewer_team_id");
    if (!viewerTeamId) throw new Error("Finish organization setup first");
    const prefix = `space_manager:${spaceId}:`;
    const managers = db.prepare(
      "SELECT key FROM okf_config WHERE substr(key, 1, ?) = ?",
    ).all(prefix.length, prefix) as Row[];
    const { storeId, modelId } = await authorization();
    await fga(`/stores/${storeId}/write`, {
      method: "POST",
      body: JSON.stringify({
        deletes: {
          tuple_keys: [
            {
              user: `source:${SOURCE}`,
              relation: "parent",
              object: `space:${spaceId}`,
            },
            {
              user: `group:${viewerTeamId}#member`,
              relation: "viewer",
              object: `space:${spaceId}`,
            },
            ...managers.map((row) => ({
              user: `user:${String(row.key).slice(prefix.length)}`,
              relation: "manager",
              object: `space:${spaceId}`,
            })),
          ],
        },
        authorization_model_id: modelId,
      }),
    });
    unset(`openfga_hub_space:${spaceId}`);
    for (const row of managers) unset(String(row.key));
  }

  async function ensureImportedSource(sourceId: string) {
    const viewerTeamId = get("viewer_team_id");
    const importedSpace = `${IMPORTED_SPACE}-${sourceId}`;
    const spaceKey = `openfga_imported_space:${sourceId}`;
    if (!get(spaceKey)) {
      if (!viewerTeamId) throw new Error("Finish organization setup first");
      await writeTuples([{
        user: `source:${SOURCE}`,
        relation: "parent",
        object: `space:${importedSpace}`,
      }, {
        user: `group:${viewerTeamId}#member`,
        relation: "viewer",
        object: `space:${importedSpace}`,
      }]);
      set(spaceKey, "1");
    }
  }

  async function ensureImportedConcept(sourceId: string, conceptId: string) {
    await ensureImportedSource(sourceId);
    const importedSpace = `${IMPORTED_SPACE}-${sourceId}`;
    const key = `openfga_imported_concept_v2:${conceptId}`;
    if (get(key)) return;
    const tuple = {
      user: `space:${importedSpace}`,
      relation: "parent",
      object: `concept:${conceptId}`,
    };
    const legacyKey = `openfga_imported_concept:${conceptId}`;
    if (get(legacyKey)) {
      const { storeId, modelId } = await authorization();
      await fga(`/stores/${storeId}/write`, {
        method: "POST",
        body: JSON.stringify({
          writes: { tuple_keys: [tuple] },
          deletes: {
            tuple_keys: [{
              user: `space:${IMPORTED_SPACE}`,
              relation: "parent",
              object: `concept:${conceptId}`,
            }],
          },
          authorization_model_id: modelId,
        }),
      });
      unset(legacyKey);
    } else {
      await writeTuples([tuple]);
    }
    set(key, "1");
  }

  function sourceAccess(sourceId: string): SourceAccess {
    const prefix = `source_grant:${sourceId}:`;
    const grants = (db.prepare(
      "SELECT key, value FROM okf_config WHERE substr(key, 1, ?) = ? ORDER BY key",
    ).all(prefix.length, prefix) as Row[]).map((row) => {
      const subject = String(row.key).slice(prefix.length);
      const split = subject.indexOf(":");
      return {
        type: subject.slice(0, split) as SourceGrant["type"],
        id: subject.slice(split + 1),
        role: String(row.value) as SourceGrant["role"],
      };
    });
    return get(`source_access:${sourceId}`) === "restricted"
      ? { mode: "restricted", grants }
      : { mode: "workspace", grants: [] };
  }

  // The imported space's access tuples are a pure function of stored access.
  function sourceAccessTuples(sourceId: string, access: SourceAccess) {
    const object = `space:${IMPORTED_SPACE}-${sourceId}`;
    if (access.mode === "workspace") {
      const viewerTeamId = get("viewer_team_id");
      return [
        { user: `source:${SOURCE}`, relation: "parent", object },
        ...viewerTeamId
          ? [{
            user: `group:${viewerTeamId}#member`,
            relation: "viewer",
            object,
          }]
          : [],
      ];
    }
    return [
      { user: `source:${SOURCE}`, relation: "workspace", object },
      ...access.grants.map((grant) => ({
        user: grant.type === "user"
          ? `user:${grant.id}`
          : `group:${grant.id}#member`,
        relation: grant.role,
        object,
      })),
    ];
  }

  function isAccessGroup(groupId: string) {
    const access = get(`group_access:${groupId}`);
    return access === "editor" || access === "viewer";
  }

  // Idempotent: only tuples that differ from the stored access are written.
  async function setSourceAccess(
    actorUserId: string,
    sourceId: string,
    requested: SourceAccess,
  ) {
    const grants = requested.mode === "workspace" ? [] : [
      ...new Map(
        requested.grants.map((grant) => [`${grant.type}:${grant.id}`, grant]),
      ).values(),
    ];
    for (const grant of grants) {
      if (
        !["viewer", "editor"].includes(grant.role) ||
        !(grant.type === "user"
          ? hasMember(grant.id)
          : grant.type === "group" && isAccessGroup(grant.id))
      ) throw new Error("Choose workspace members or groups");
    }
    const next: SourceAccess = { mode: requested.mode, grants };
    await ensureImportedSource(sourceId);
    const previous = sourceAccess(sourceId);
    const key = (tuple: { user: string; relation: string }) =>
      `${tuple.user} ${tuple.relation}`;
    const before = sourceAccessTuples(sourceId, previous);
    const after = sourceAccessTuples(sourceId, next);
    const writes = after.filter((tuple) =>
      !before.some((item) => key(item) === key(tuple))
    );
    const deletes = before.filter((tuple) =>
      !after.some((item) => key(item) === key(tuple))
    );
    if (writes.length || deletes.length) {
      // shortcut: one atomic write fits OpenFGA's 100-tuple limit only because routes cap grants at 45; batch if that cap grows.
      const { storeId, modelId } = await authorization();
      await fga(`/stores/${storeId}/write`, {
        method: "POST",
        body: JSON.stringify({
          ...writes.length ? { writes: { tuple_keys: writes } } : {},
          ...deletes.length ? { deletes: { tuple_keys: deletes } } : {},
          authorization_model_id: modelId,
        }),
      });
    }
    const prefix = `source_grant:${sourceId}:`;
    db.prepare(
      "DELETE FROM okf_config WHERE substr(key, 1, ?) = ?",
    ).run(prefix.length, prefix);
    for (const grant of grants) {
      set(`${prefix}${grant.type}:${grant.id}`, grant.role);
    }
    next.mode === "restricted"
      ? set(`source_access:${sourceId}`, "restricted")
      : unset(`source_access:${sourceId}`);
    if (previous.mode !== next.mode) {
      audit(
        actorUserId,
        next.mode === "restricted"
          ? "source.access_restricted"
          : "source.access_opened",
        `source:${sourceId}`,
      );
    }
    const label = (grant: SourceGrant) =>
      `source:${sourceId}:${grant.type}:${grant.id}:${grant.role}`;
    const was = new Set(previous.grants.map(label));
    const now = new Set(grants.map(label));
    for (const item of now) {
      if (!was.has(item)) audit(actorUserId, "source.access_granted", item);
    }
    for (const item of was) {
      if (!now.has(item)) audit(actorUserId, "source.access_revoked", item);
    }
    return next;
  }

  async function deleteImportedSource(sourceId: string, conceptIds: string[]) {
    const deletes = [];
    const settings = [];
    const importedSpace = `${IMPORTED_SPACE}-${sourceId}`;
    for (const conceptId of conceptIds) {
      const currentKey = `openfga_imported_concept_v2:${conceptId}`;
      if (get(currentKey)) {
        deletes.push({
          user: `space:${importedSpace}`,
          relation: "parent",
          object: `concept:${conceptId}`,
        });
        settings.push(currentKey);
      }
      const legacyKey = `openfga_imported_concept:${conceptId}`;
      if (get(legacyKey)) {
        deletes.push({
          user: `space:${IMPORTED_SPACE}`,
          relation: "parent",
          object: `concept:${conceptId}`,
        });
        settings.push(legacyKey);
      }
    }
    const spaceKey = `openfga_imported_space:${sourceId}`;
    if (get(spaceKey)) {
      deletes.push(...sourceAccessTuples(sourceId, sourceAccess(sourceId)));
      settings.push(spaceKey, `source_access:${sourceId}`);
      const prefix = `source_grant:${sourceId}:`;
      settings.push(
        ...(db.prepare(
          "SELECT key FROM okf_config WHERE substr(key, 1, ?) = ?",
        ).all(prefix.length, prefix) as Row[]).map((row) => String(row.key)),
      );
    }
    if (!deletes.length) return;
    const { storeId, modelId } = await authorization();
    await fga(`/stores/${storeId}/write`, {
      method: "POST",
      body: JSON.stringify({
        deletes: { tuple_keys: deletes },
        authorization_model_id: modelId,
      }),
    });
    for (const key of settings) unset(key);
  }

  function pendingInvitationFor(email: string) {
    const row = db.prepare(
      "SELECT id FROM invitation WHERE lower(email) = lower(?) AND status = 'pending' ORDER BY createdAt DESC LIMIT 1",
    ).get(email) as Row | undefined;
    return row ? String(row.id) : undefined;
  }

  async function bootstrap(current: NonNullable<Session>) {
    const membership = member(current.user.id);
    const configured = Boolean(get("organization_id"));
    const organizationExists = Boolean(
      db.prepare('SELECT 1 FROM "organization" LIMIT 1').get(),
    );
    const owner = isOwner(current.user.id);
    const canView = configured && membership
      ? await check(current.user.id, "view")
      : false;
    const canEdit = configured && membership
      ? await check(current.user.id, "edit")
      : false;
    const editorTeamId = get("editor_team_id");
    const viewerTeamId = get("viewer_team_id");
    const organizationId = get("organization_id") ?? "";
    const customAccessFor = (userId: string) => {
      if (!organizationId) return undefined;
      const memberships = db.prepare(
        `SELECT tm.teamId FROM teamMember tm
         JOIN team t ON t.id = tm.teamId
         WHERE tm.userId = ? AND t.organizationId = ?`,
      ).all(userId, organizationId) as Row[];
      let access: "editor" | "viewer" | undefined;
      for (const membership of memberships) {
        const configured = get(`group_access:${membership.teamId}`);
        if (configured === "editor") return "editor";
        if (configured === "viewer") access = "viewer";
      }
      return access;
    };
    const inEditorGroup = editorTeamId &&
      db.prepare("SELECT 1 FROM teamMember WHERE userId = ? AND teamId = ?")
        .get(current.user.id, editorTeamId);
    const inViewerGroup = viewerTeamId &&
      db.prepare("SELECT 1 FROM teamMember WHERE userId = ? AND teamId = ?")
        .get(current.user.id, viewerTeamId);
    const customAccess = customAccessFor(current.user.id);
    const access = owner
      ? "owner"
      : inEditorGroup || customAccess === "editor"
      ? "editor"
      : inViewerGroup || customAccess === "viewer"
      ? "viewer"
      : "none";
    const organization = organizationId
      ? db.prepare('SELECT name FROM "organization" WHERE id = ?').get(
        organizationId,
      ) as Row | undefined
      : undefined;
    const workspace = {
      name: get("workspace_name") ?? String(organization?.name ?? "OKF Hub"),
      tagline: get("workspace_tagline") ?? "Company knowledge",
      logo: get("workspace_logo") ?? "",
    };
    const members = owner && organizationId
      ? (db.prepare(
        `SELECT u.id, u.name, u.email, m.role
         FROM member m JOIN "user" u ON u.id = m.userId
         WHERE m.organizationId = ? ORDER BY u.name, u.email`,
      ).all(organizationId) as Row[]).map((item) => {
        const userId = String(item.id);
        const editor = editorTeamId && db.prepare(
          "SELECT 1 FROM teamMember WHERE userId = ? AND teamId = ?",
        ).get(userId, editorTeamId);
        const viewer = viewerTeamId && db.prepare(
          "SELECT 1 FROM teamMember WHERE userId = ? AND teamId = ?",
        ).get(userId, viewerTeamId);
        const customAccess = customAccessFor(userId);
        return {
          id: userId,
          name: String(item.name),
          email: String(item.email),
          access: String(item.role).split(",").includes("owner")
            ? "owner"
            : editor || customAccess === "editor"
            ? "editor"
            : viewer || customAccess === "viewer"
            ? "viewer"
            : "member",
        };
      })
      : [];
    const groups = owner && organizationId
      ? (db.prepare(
        `SELECT t.id, t.name, COUNT(tm.id) AS memberCount
         FROM team t LEFT JOIN teamMember tm ON tm.teamId = t.id
         WHERE t.organizationId = ? GROUP BY t.id, t.name ORDER BY t.name`,
      ).all(organizationId) as Row[]).flatMap((item) => {
        const access = get(`group_access:${item.id}`);
        return access === "editor" || access === "viewer"
          ? [{
            id: String(item.id),
            name: String(item.name),
            memberCount: Number(item.memberCount),
            access,
          }]
          : [];
      })
      : [];
    const invitations = owner
      ? db.prepare(
        `SELECT d.invitationId, d.email, d.access, d.url, i.status FROM okf_invite_delivery d JOIN invitation i ON i.id = d.invitationId WHERE i.status = 'pending' ORDER BY i.createdAt DESC`,
      ).all()
      : [];
    const pendingInvitationId = pendingInvitationFor(current.user.email);
    return json({
      user: current.user,
      access,
      canView,
      canEdit,
      setupRequired: !configured && (owner || !organizationExists),
      passwordChangeRequired: Boolean(
        get(`password_change:${current.user.id}`),
      ),
      invitationRequired: !membership && Boolean(pendingInvitationId),
      invitations,
      workspace,
      members,
      groups,
    });
  }

  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (
      url.pathname === "/api/auth/sign-up/email" && request.method === "POST"
    ) {
      const body = await request.clone().json().catch(() => ({})) as Row;
      const email = String(body.email ?? "").trim().toLowerCase();
      const setupToken = String(body.setupToken ?? "");
      delete body.setupToken;
      let allowed = false;
      if (!get("organization_id")) {
        const expected = setupURL() && get("setup_token");
        if (requireSetupToken && (!expected || setupToken !== expected)) {
          return json({
            error:
              "Open the setup link from the server logs to create the first account",
          }, 403);
        }
        if (expected) {
          // Single use: consumed before the account exists, restored if signup fails.
          unset("setup_token");
          allowedSignups.add(email);
          allowed = true;
        }
      } else {
        const invitationId = String(body.invitationId ?? "");
        const invitation = invitationId
          ? db.prepare(
            "SELECT email, status FROM invitation WHERE id = ?",
          ).get(invitationId) as Row | undefined
          : undefined;
        if (
          !invitation || invitation.status !== "pending" ||
          String(invitation.email).toLowerCase() !== email
        ) {
          return json({
            error: "A valid workspace invitation is required to sign up",
          }, 403);
        }
      }
      delete body.invitationId;
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      try {
        const response = await auth.handler(
          new Request(request.url, {
            method: request.method,
            headers,
            body: JSON.stringify(body),
          }),
        );
        if (allowed && !response.ok) set("setup_token", setupToken);
        if (allowed && response.ok) {
          const created = findUser(email);
          if (created) {
            audit(String(created.id), "setup.account_created", "workspace");
          }
        }
        return response;
      } finally {
        if (allowed) allowedSignups.delete(email);
      }
    }
    // Login links are minted only by the host operator CLI.
    if (
      url.pathname.toLowerCase().replace(/\/+/g, "/").replace(/\/$/, "") ===
        "/api/auth/sign-in/magic-link"
    ) {
      return json({ error: "Not found" }, 404);
    }
    if (
      url.pathname === "/api/auth/change-password" && request.method === "POST"
    ) {
      const current = await session(request);
      const response = await auth.handler(request);
      if (current && response.ok) {
        unset(`password_change:${current.user.id}`);
      }
      return response;
    }
    if (url.pathname.startsWith("/api/auth/")) return auth.handler(request);
    if (!url.pathname.startsWith("/api/")) return null;
    if (
      url.pathname === "/api/openapi.json" ||
      url.pathname.startsWith("/api/v1/")
    ) return null;
    const current = await session(request);
    if (url.pathname === "/api/bootstrap" && request.method === "GET") {
      return current ? await bootstrap(current) : json({
        user: null,
        signupAllowed: !get("organization_id") &&
          (!requireSetupToken || Boolean(setupURL())),
        setupTokenRequired: requireSetupToken && !get("organization_id"),
        ssoProviders: ssoProviders.map(({ providerId, name, type }) => ({
          providerId,
          name,
          type,
        })),
      });
    }
    if (!current) return json({ error: "Sign in required" }, 401);

    if (url.pathname === "/api/setup" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as Row;
      const name = String(body.name ?? "").trim();
      const tagline = String(body.tagline ?? "").trim();
      if (!name || name.length > 60 || tagline.length > 100) {
        return json(
          { error: "Enter a workspace name under 60 characters" },
          400,
        );
      }
      try {
        await setup(current, request.headers, name, tagline);
        return await bootstrap(current);
      } catch (error) {
        return json({
          error: error instanceof Error ? error.message : "Setup failed",
        }, 503);
      }
    }
    if (url.pathname === "/api/workspace" && request.method === "PUT") {
      if (!isOwner(current.user.id)) {
        return json({ error: "Owner access required" }, 403);
      }
      const body = await request.json().catch(() => ({})) as Row;
      const name = String(body.name ?? "").trim();
      const tagline = String(body.tagline ?? "").trim();
      const logo = String(body.logo ?? "");
      if (!name || name.length > 60 || tagline.length > 100) {
        return json({ error: "Workspace name or tagline is too long" }, 400);
      }
      if (
        logo &&
        (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo) ||
          logo.length > 350_000)
      ) {
        return json(
          { error: "Use a PNG, JPEG, or WebP logo under 256 KB" },
          400,
        );
      }
      set("workspace_name", name);
      tagline ? set("workspace_tagline", tagline) : unset("workspace_tagline");
      logo ? set("workspace_logo", logo) : unset("workspace_logo");
      audit(current.user.id, "workspace.updated", "workspace:company");
      return await bootstrap(current);
    }
    const ownerRoute = url.pathname.match(/^\/api\/members\/([^/]+)\/owner$/);
    if (ownerRoute && request.method === "PUT") {
      if (!isOwner(current.user.id)) {
        return json({ error: "Owner access required" }, 403);
      }
      const userId = decodeURIComponent(ownerRoute[1]);
      const body = await request.json().catch(() => ({})) as Row;
      if (typeof body.owner !== "boolean" || !hasMember(userId)) {
        return json({ error: "Choose a workspace member" }, 400);
      }
      if (userId === current.user.id) {
        return json({ error: "Ask another owner to change your access" }, 400);
      }
      try {
        if (await setOwner(userId, body.owner)) {
          audit(
            current.user.id,
            body.owner ? "member.owner_granted" : "member.owner_revoked",
            `user:${userId}`,
          );
        }
        return await bootstrap(current);
      } catch (error) {
        return json({
          error: error instanceof Error ? error.message : "Update failed",
        }, 409);
      }
    }
    if (url.pathname === "/api/groups" && request.method === "POST") {
      if (!isOwner(current.user.id)) {
        return json({ error: "Owner access required" }, 403);
      }
      const body = await request.json().catch(() => ({})) as Row;
      const name = String(body.name ?? "").trim();
      const access = body.access === "editor" || body.access === "viewer"
        ? String(body.access)
        : "";
      const organizationId = get("organization_id");
      if (!organizationId || !name || name.length > 60 || !access) {
        return json({ error: "Enter a group name and permission level" }, 400);
      }
      if (
        db.prepare("SELECT 1 FROM team WHERE organizationId = ? AND name = ?")
          .get(organizationId, name)
      ) {
        return json({ error: "A group with this name already exists" }, 409);
      }
      try {
        const created = await authCall(() =>
          auth.api.createTeam({
            headers: request.headers,
            body: { name, organizationId },
          })
        ) as Row;
        const id = String(created.id);
        set(`group_access:${id}`, access);
        await writeTuples([{
          user: `group:${id}#member`,
          relation: access,
          object: `source:${SOURCE}`,
        }]);
        audit(current.user.id, "group.created", `group:${id}:${access}`);
        return json({ id, name, access, memberCount: 0 }, 201);
      } catch (error) {
        return json({
          error: error instanceof Error
            ? error.message
            : "Group creation failed",
        }, 400);
      }
    }
    if (url.pathname === "/api/invitations" && request.method === "POST") {
      if (!isOwner(current.user.id)) {
        return json({ error: "Owner access required" }, 403);
      }
      const body = await request.json().catch(() => ({})) as Row;
      const email = String(body.email ?? "").trim().toLowerCase();
      const requestedTeamId = String(body.teamId ?? "");
      let access = body.access === "editor" || body.access === "viewer"
        ? String(body.access)
        : "";
      if (!/^\S+@\S+\.\S+$/.test(email)) {
        return json({ error: "Enter an email and access level" }, 400);
      }
      const organizationId = get("organization_id");
      const requestedTeam = requestedTeamId && organizationId
        ? db.prepare(
          "SELECT id FROM team WHERE id = ? AND organizationId = ?",
        ).get(requestedTeamId, organizationId) as Row | undefined
        : undefined;
      const teamId = requestedTeam ? requestedTeamId : get(`${access}_team_id`);
      if (requestedTeam) {
        access = get(`group_access:${requestedTeamId}`) ??
          (requestedTeamId === get("editor_team_id") ? "editor" : "viewer");
      }
      if (!organizationId || !teamId) {
        return json({ error: "Finish organization setup first" }, 409);
      }
      try {
        const invitation = await authCall(() =>
          auth.api.createInvitation({
            headers: request.headers,
            body: { email, role: "member", organizationId, teamId },
          })
        ) as Row;
        const invitationId = String(invitation.id);
        const invitationURL = `${baseURL}/?invitation=${
          encodeURIComponent(invitationId)
        }`;
        db.prepare(
          "INSERT INTO okf_invite_delivery (invitationId, email, access, url) VALUES (?, ?, ?, ?) ON CONFLICT(invitationId) DO UPDATE SET access = excluded.access, url = excluded.url",
        ).run(invitationId, email, access, invitationURL);
        audit(current.user.id, "invitation.created", `${access}:${email}`);
        return json({ id: invitationId, url: invitationURL });
      } catch (error) {
        return json({
          error: error instanceof Error ? error.message : "Invitation failed",
        }, 400);
      }
    }
    if (
      url.pathname === "/api/invitations/accept" && request.method === "POST"
    ) {
      const body = await request.json().catch(() => ({})) as Row;
      // Without an id, fall back to the invitation issued to the signed-in email.
      const invitationId = String(
        body.invitationId ?? pendingInvitationFor(current.user.email) ?? "",
      );
      const invitation = db.prepare(
        "SELECT email, teamId, status FROM invitation WHERE id = ?",
      ).get(invitationId) as Row | undefined;
      if (
        !invitation ||
        String(invitation.email).toLowerCase() !==
          current.user.email.toLowerCase() ||
        invitation.status !== "pending"
      ) return json({ error: "Invitation not found" }, 404);
      try {
        await authCall(() =>
          auth.api.acceptInvitation({
            headers: request.headers,
            body: { invitationId },
          })
        );
        await writeTuples([{
          user: `user:${current.user.id}`,
          relation: "member",
          object: `group:${invitation.teamId}`,
        }]);
        audit(
          current.user.id,
          "invitation.accepted",
          `group:${invitation.teamId}`,
        );
        return await bootstrap(current);
      } catch (error) {
        return json({
          error: error instanceof Error ? error.message : "Invitation failed",
        }, 400);
      }
    }
    if (url.pathname === "/api/audit" && request.method === "GET") {
      if (!isOwner(current.user.id)) {
        return json({ error: "Owner access required" }, 403);
      }
      return json(
        db.prepare(
          "SELECT occurredAt, action, target FROM okf_audit ORDER BY id DESC LIMIT 50",
        ).all(),
      );
    }
    if (url.pathname === "/api/developer/keys" && request.method === "GET") {
      return json({ keys: apiKeys(current.user.id) });
    }
    if (url.pathname === "/api/developer/keys" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as Row;
      try {
        return json(
          await createApiKey(
            current.user.id,
            String(body.name ?? ""),
            Array.isArray(body.scopes) ? body.scopes.map(String) : [],
            typeof body.expiresAt === "string" ? body.expiresAt : undefined,
          ),
          201,
        );
      } catch (error) {
        return json({
          error: error instanceof Error
            ? error.message
            : "API key creation failed",
        }, 400);
      }
    }
    const apiKeyRoute = url.pathname.match(/^\/api\/developer\/keys\/([^/]+)$/);
    if (apiKeyRoute && request.method === "DELETE") {
      const id = decodeURIComponent(apiKeyRoute[1]);
      const result = db.prepare(
        "UPDATE okf_api_key SET revokedAt = ? WHERE id = ? AND userId = ? AND revokedAt IS NULL",
      ).run(new Date().toISOString(), id, current.user.id);
      if (!result.changes) return json({ error: "API key not found" }, 404);
      audit(current.user.id, "api_key.revoked", `api_key:${id}`);
      return new Response(null, { status: 204 });
    }
    return null;
  }

  return {
    auth,
    session,
    authenticate,
    check,
    checkSpace,
    handle,
    isOwner,
    hasMember,
    setOwner,
    setupURL,
    operator,
    setSpaceManager,
    spaceManagers,
    audit,
    activity,
    ensureHubSpace,
    ensureHubConcept,
    moveHubConcept,
    deleteHubSpace,
    ensureImportedConcept,
    ensureImportedSource,
    deleteImportedSource,
    sourceAccess,
    setSourceAccess,
    close: () => db.close(),
  };
}

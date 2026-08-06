/// <reference lib="deno.ns" />

import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { organization } from "better-auth/plugins";

type Session = Awaited<
  ReturnType<ReturnType<typeof betterAuth>["api"]["getSession"]>
>;
type Row = Record<string, unknown>;

const SOURCE = "company";
const SPACE = "policies";
const IMPORTED_SPACE = "imported";
export const CONCEPT = "incident-communication";

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
        editor: { this: {} },
        viewer: { this: {} },
        edit: {
          union: {
            child: [{ computedUserset: { relation: "editor" } }, {
              tupleToUserset: {
                tupleset: { relation: "parent" },
                computedUserset: { relation: "edit" },
              },
            }],
          },
        },
        view: {
          union: {
            child: [{ computedUserset: { relation: "editor" } }, {
              computedUserset: { relation: "viewer" },
            }, {
              tupleToUserset: {
                tupleset: { relation: "parent" },
                computedUserset: { relation: "view" },
              },
            }],
          },
        },
      },
      metadata: {
        relations: {
          parent: { directly_related_user_types: [{ type: "source" }] },
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
}: {
  dataDir: string;
  baseURL?: string;
  authSecret?: string;
  openfgaURL?: string;
  openfgaKey?: string;
}) {
  const db = new DatabaseSync(`${dataDir}/hub.db`);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  const authSecretValue = await secret(dataDir, authSecret);
  const auth = betterAuth({
    baseURL,
    secret: authSecretValue,
    secrets: [{ version: 1, value: authSecretValue }],
    trustedOrigins: [baseURL, "http://127.0.0.1:3000", "http://localhost:3000"],
    database: db,
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    telemetry: { enabled: false },
    plugins: [organization({ teams: { enabled: true } })],
  });
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
  `);

  const get = (key: string) =>
    (db.prepare("SELECT value FROM okf_config WHERE key = ?").get(key) as
      | Row
      | undefined)?.value as string | undefined;
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
  const session = (request: Request) =>
    auth.api.getSession({ headers: request.headers });

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
    if (!modelId) {
      const result = await fga(`/stores/${storeId}/authorization-models`, {
        method: "POST",
        body: JSON.stringify(model),
      }) as Row;
      modelId = String(result.authorization_model_id);
      set("openfga_model_id", modelId);
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
    relation: "view" | "edit",
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
    relation: "view" | "edit",
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

  async function setup(current: NonNullable<Session>, headers: Headers) {
    let org = db.prepare(
      'SELECT id FROM "organization" ORDER BY createdAt LIMIT 1',
    ).get() as Row | undefined;
    if (!org) {
      org = await auth.api.createOrganization({
        headers,
        body: { name: "OKF Hub", slug: "okf-hub" },
      }) as Row;
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
      const created = await auth.api.createTeam({
        headers,
        body: { name, organizationId },
      }) as Row;
      return String(created.id);
    };
    const editorTeamId = await ensureTeam("Policy editors");
    const viewerTeamId = await ensureTeam("Policy viewers");
    const firstSetup = !get("organization_id");
    set("organization_id", organizationId);
    set("editor_team_id", editorTeamId);
    set("viewer_team_id", viewerTeamId);
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

  async function deleteHubSpace(spaceId: string) {
    const viewerTeamId = get("viewer_team_id");
    if (!viewerTeamId) throw new Error("Finish organization setup first");
    const { storeId, modelId } = await authorization();
    await fga(`/stores/${storeId}/write`, {
      method: "POST",
      body: JSON.stringify({
        deletes: {
          tuple_keys: [{
            user: `source:${SOURCE}`,
            relation: "parent",
            object: `space:${spaceId}`,
          }, {
            user: `group:${viewerTeamId}#member`,
            relation: "viewer",
            object: `space:${spaceId}`,
          }],
        },
        authorization_model_id: modelId,
      }),
    });
    unset(`openfga_hub_space:${spaceId}`);
  }

  async function ensureImportedConcept(sourceId: string, conceptId: string) {
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
    const inEditorGroup = editorTeamId &&
      db.prepare("SELECT 1 FROM teamMember WHERE userId = ? AND teamId = ?")
        .get(current.user.id, editorTeamId);
    const inViewerGroup = viewerTeamId &&
      db.prepare("SELECT 1 FROM teamMember WHERE userId = ? AND teamId = ?")
        .get(current.user.id, viewerTeamId);
    const access = owner
      ? "owner"
      : inEditorGroup
      ? "editor"
      : inViewerGroup
      ? "viewer"
      : "none";
    const invitations = owner
      ? db.prepare(
        `SELECT d.invitationId, d.email, d.access, d.url, i.status FROM okf_invite_delivery d JOIN invitation i ON i.id = d.invitationId ORDER BY i.createdAt DESC`,
      ).all()
      : [];
    return json({
      user: current.user,
      access,
      canView,
      canEdit,
      setupRequired: !configured && (owner || !organizationExists),
      invitationRequired: !membership &&
        Boolean(
          db.prepare(
            "SELECT 1 FROM invitation WHERE email = ? AND status = 'pending'",
          ).get(current.user.email),
        ),
      invitations,
    });
  }

  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/auth/")) return auth.handler(request);
    if (!url.pathname.startsWith("/api/")) return null;
    const current = await session(request);
    if (url.pathname === "/api/bootstrap" && request.method === "GET") {
      return current ? await bootstrap(current) : json({ user: null });
    }
    if (!current) return json({ error: "Sign in required" }, 401);

    if (url.pathname === "/api/setup" && request.method === "POST") {
      try {
        await setup(current, request.headers);
        return await bootstrap(current);
      } catch (error) {
        return json({
          error: error instanceof Error ? error.message : "Setup failed",
        }, 503);
      }
    }
    if (url.pathname === "/api/invitations" && request.method === "POST") {
      if (!isOwner(current.user.id)) {
        return json({ error: "Owner access required" }, 403);
      }
      const body = await request.json().catch(() => ({})) as Row;
      const email = String(body.email ?? "").trim().toLowerCase();
      const access = body.access === "editor" || body.access === "viewer"
        ? body.access
        : "";
      if (!/^\S+@\S+\.\S+$/.test(email) || !access) {
        return json({ error: "Enter an email and access level" }, 400);
      }
      const organizationId = get("organization_id");
      const teamId = get(`${access}_team_id`);
      if (!organizationId || !teamId) {
        return json({ error: "Finish organization setup first" }, 409);
      }
      try {
        const invitation = await auth.api.createInvitation({
          headers: request.headers,
          body: { email, role: "member", organizationId, teamId },
        }) as Row;
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
      const invitationId = String(body.invitationId ?? "");
      const invitation = db.prepare(
        "SELECT email, teamId, status FROM invitation WHERE id = ?",
      ).get(invitationId) as Row | undefined;
      if (
        !invitation || invitation.email !== current.user.email ||
        invitation.status !== "pending"
      ) return json({ error: "Invitation not found" }, 404);
      try {
        await auth.api.acceptInvitation({
          headers: request.headers,
          body: { invitationId },
        });
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
    return null;
  }

  return {
    auth,
    session,
    check,
    checkSpace,
    handle,
    isOwner,
    audit,
    ensureHubSpace,
    ensureHubConcept,
    moveHubConcept,
    deleteHubSpace,
    ensureImportedConcept,
    close: () => db.close(),
  };
}

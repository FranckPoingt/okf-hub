---
type: Architecture
title: OKF Hub extensibility
description: The permission-filtered action, connector, and sandboxed App model.
tags: [okf-hub, apps, connectors, architecture]
status: stable
---

# OKF Hub extensibility

OKF is the durable knowledge kernel. Human UI, developer clients, connectors,
Apps, automation, and agents are adapters over the same permission-filtered
operations; none of them becomes a second source of canonical knowledge.

## Implemented foundation

### Knowledge actions

`server/action-catalog.ts` defines the shared operation catalog. Each action has
an input schema, an approval mode, and one implementation. The catalog validates
input and projects actions into:

- `GET /api/v1/actions` for discovery;
- `POST /api/v1/actions/:name` for invocation;
- `GET /api/openapi.json` for OpenAPI 3.1 clients;
- [MCP Streamable HTTP](mcp.md) at `/api/mcp` for agents;
- sandboxed Apps through the parent-frame bridge.

The first actions cover knowledge search, template discovery, concept creation,
concept reads and draft updates, work traces, source discovery, App lifecycle,
and per-user App data. Every implementation performs the same OpenFGA decision
regardless of caller.

### Developer authentication

Every member creates scoped API keys from **Developer API** in the profile menu;
a key never exceeds its user's access. Keys use 256-bit random values, are
stored only as SHA-256 hashes, are shown once, and may be revoked. A key scope
is an action name or wildcard such as `knowledge.*`.

```sh
curl -X POST https://hub.example/api/v1/actions/knowledge.search \
  -H "Authorization: Bearer okf_..." \
  -H "Content-Type: application/json" \
  -d '{"query":"incident response"}'
```

### Connectors

`src/lib/connectors.ts` is the shared connector catalog. Its metadata drives the
owner settings UI, setup fields, enabled state, and `import`/`embed`
capabilities. `server/connector-registry.ts` maps import providers to the shared
OKF snapshot contract; `src/lib/embeds.ts` maps embed providers to safe preview
URLs. Import, provenance, retry, validation, and permission behavior stay owned
by the hub rather than each adapter.

Provider implementations remain ordinary reviewed code. The catalog removes
per-provider settings UI, not the trust boundary by loading arbitrary connector
code at runtime.

### Apps

Apps replace the former Artifacts product surface while retaining its useful
implementation: versions, review, activation by owners and space managers, CSP,
iframe isolation, OpenFGA checks, and audit history. "Artifact" now names a
document of type `Artifact` that carries a static App and its `context.md`; the
Hub opens it App-first and lists permitted ones in the **Artifacts** gallery
(see [Save a Codex artifact](codex-artifacts.md)).

Workspace owners and managers of the document's space can activate an App.
Document editors can draft and revise but cannot activate. Owners assign space
managers with `PUT` or `DELETE /api/spaces/{spaceId}/managers/{userId}`. A
manager can also edit documents in that space. Existing stores receive the new
`manager` relation through a versioned authorization-model migration at startup.

The default no-deploy workflow accepts a folder of static web files with an
`index.html` entry. The complete folder becomes one reviewed version and is
served behind OKF identity from the existing customer-controlled store. This
keeps the authoring primitive aligned with a normal web project rather than an
HTML field inside the knowledge UI.

A bundled App receives a tiny browser bridge:

```js
const results = await okf.action("knowledge.search", { query: "onboarding" });
await okf.data.set("settings", "team", { id: "operations" });
```

Only actions explicitly granted in the reviewed App version can cross the
bridge. `okf.data` is isolated by App and user. Secrets, cookies, the parent
DOM, raw SQL, and direct network access are not exposed.

#### Bundle capability URLs

The App iframe uses `sandbox="allow-scripts"`, so its origin is opaque. Module
scripts and imports are CORS requests that send `Origin: null` without cookies.
The cookie-authenticated `/api/apps/:id/files/*` route correctly refuses them.
When the Hub shows an App, it calls `POST /api/apps/:id/capability`. That
requires a session that can view the App. The call mints a 256-bit random token
scoped to one user and the one App version that user would see: the draft for
editors, the activated version for readers. An editor can send `{"live": true}`
to preview the activated version instead; readers always get it. It expires
after 10 minutes and the Hub mints a new one on every load. Only its SHA-256
hash is kept, in server memory. The iframe loads from
`/app-files/<token>/<path>`, which needs no cookie. That route answers `GET`
only, sends `Access-Control-Allow-Origin: *` and never sends
`Access-Control-Allow-Credentials`. It keeps the bundle CSP (also sent as a
response header), `nosniff`, and file MIME types. On every request it re-checks
the user's current view permission and the pinned version. Unknown, expired,
revoked, and superseded tokens all receive the same 404. Opening the entry file
through the route records App usage as before.

Threat model: the Hub never accepts `Origin: null` with credentials. Doing so
would let any sandboxed page on the internet read Hub data with a visitor's
session. A capability token is a bearer secret, so anyone who obtains one can
read the static files of that one App version until it expires, but nothing
else. It cannot call actions, read documents or App data, or reach any other
route, because the bridge stays the parent's `postMessage` relay and that relay
uses the parent's session and the reviewed grants. The token appears in the
iframe URL. `no-referrer` and the CSP keep it out of referrers and requests. An
App could still navigate its own frame to leak the token, but that would expose
only files the App already contains.

## Deliberately deferred

Generated server code does not run inside the Deno application process. That
process owns database, object-store, network, and Git authority, so in-process
plugins would defeat the capability model.

Add an executable Worker, WASM, or subprocess adapter only after two real local
extensions require server-side code. It must provide isolation, explicit grants,
resource limits, logs, review, rollback, and customer-controlled persistence.
Until then, no-deploy expansion means Apps composed from existing actions.

BlockSuite or a Guide-style canvas may later be another view adapter. It may
reference OKF concepts and Apps, but Markdown/OKF remains authoritative.

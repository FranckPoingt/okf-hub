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
- sandboxed Apps through the parent-frame bridge.

The first actions cover knowledge search, template discovery, concept creation,
concept reads and draft updates, work traces, source discovery, App lifecycle,
and per-user App data. Every implementation performs the same OpenFGA decision
regardless of caller.

### Developer authentication

Users create scoped API keys from **Developer API** in the profile menu. Keys
use 256-bit random values, are stored only as SHA-256 hashes, are shown once,
and may be revoked. A key scope is an action name or wildcard such as
`knowledge.*`.

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
implementation: versions, review, owner activation, CSP, iframe isolation,
OpenFGA checks, and audit history.

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

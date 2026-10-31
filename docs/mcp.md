---
type: Guide
title: Connect agents to OKF Hub with MCP
description: Read permitted Hub knowledge and retain static artifacts through scoped developer keys.
tags: [okf-hub, mcp, agents, artifacts]
status: beta
---

# Connect agents to OKF Hub with MCP

The existing Hub server exposes Streamable HTTP at `/api/mcp`. No extra process
or dependency is needed. Use HTTPS for a remote Hub. Authentication uses an
existing Developer API key (`Authorization: Bearer okf_...`), with no OAuth or
cookie login. Every request rechecks the key, including expiry and revocation.
Scopes limit available tools; the key's user still needs OpenFGA access.

## Create a key

Sign in and open **Developer API** from the profile menu. For reading, select:

```text
knowledge.search
documents.get
spaces.list
```

Tool names and input schemas come from the same catalog as the HTTP API. Search
returns accessible IDs; pass an ID to `documents.get` to read a hub-native or
imported concept with its source provenance, owner, and trust. Editors can read
working drafts; readers only see published hub-native knowledge. Agents should
cite the returned provenance and distinguish drafts from published knowledge.

To save artifacts, also select all these scopes (the composite tool is hidden
unless all are present):

```text
artifact.save
documents.create
documents.update-draft
documents.trace.create
apps.list
apps.create
apps.revise
```

Retain the read scopes above. Add `documents.publish` and `apps.activate` only
if publication is wanted; App activation still requires the key's user to be a
workspace owner or a manager of the document's space. Other catalog tools are
exposed only when their scopes permit them.

## Tools

Each tool requires its named scope; component scopes and user permissions still
apply. The same actions are available through HTTP and OpenAPI.

| Tool                      | Purpose                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| `knowledge.search`        | Permission-filtered full-text search                                         |
| `knowledge.ask`           | Workspace answer and numbered citations; listed only with an AI provider     |
| `knowledge.relationships` | Visible links, backlinks, shared definitions, conflicts, trust and freshness |
| `documents.get`           | Read permitted context, drafts for editors and published content for readers |
| `documents.create`        | Create a document                                                            |
| `documents.update-draft`  | Update an editable draft                                                     |
| `documents.publish`       | Publish document context                                                     |
| `documents.trace.create`  | Record an immutable work trace                                               |
| `artifact.get`            | Pull visible context and App files; also requires `documents.get`            |
| `artifact.save`           | Save or revise an artifact with context and a trace                          |
| `apps.list`               | List visible Apps                                                            |
| `apps.create`             | Create a draft App                                                           |
| `apps.revise`             | Revise an editable App                                                       |
| `apps.activate`           | Activate an App as an owner or space manager                                 |
| `sources.list`            | Inspect accessible sources                                                   |
| `sources.suggest-change`  | Suggest an imported Git edit via PR, or return a manual-source patch         |
| `spaces.list`             | List accessible spaces                                                       |
| `templates.list`          | List reusable templates for editors                                          |

`knowledge.ask` accepts `question` and returns `{answer, citations}` using the
same workspace retrieval and responder as Ask OKF. `knowledge.relationships`
accepts a concept `id`. `sources.suggest-change` accepts `sourceId`, `path`,
`baseRevision`, edited Markdown `body` and `rationale`, with the same validation
and source editor requirement as the UI. Its result contains `url` or `patch`.

## Claude Code

Read the key into your shell without putting its value into history (zsh):

```sh
read -rs 'OKF_HUB_TOKEN?Paste your Hub API key: '
export OKF_HUB_TOKEN
claude mcp add --transport http okf-hub https://hub.example/api/mcp \
  --header "Authorization: Bearer ${OKF_HUB_TOKEN}"
claude mcp get okf-hub
```

Replace `https://hub.example` with your Hub origin, for example
`http://localhost:8788` for a local server. This command stores the expanded
header in Claude's local configuration; keep that configuration private. See
[Claude Code's HTTP setup](https://code.claude.com/docs/en/mcp).

## Codex

Export `OKF_HUB_TOKEN` before starting Codex, then add this to
`~/.codex/config.toml`:

```toml
[mcp_servers.okf_hub]
url = "https://hub.example/api/mcp"
bearer_token_env_var = "OKF_HUB_TOKEN"
```

See [Codex MCP configuration](https://developers.openai.com/codex/mcp/). Other
MCP clients can use the same URL with a Bearer header. Clients must support
custom headers; OAuth-only remote connector setup is not supported.

To have Claude Code or Codex save artifacts without prompting, install the
[agent instructions](../integrations/README.md).

## Save and revise an artifact

Call `artifact.save` with arguments like:

```json
{
  "spaceId": "policies",
  "files": {
    "index.html": "<!doctype html><h1>Team dashboard</h1>",
    "context.md": "# Team dashboard\n\nOwner: <named person or team>.\nSources: <Hub concept IDs, or none>.\nAssumptions, inputs, outputs, limitations, and update triggers."
  }
}
```

`files` maps relative paths to UTF-8 text or base64 data URLs for binary assets.
The CLI and MCP share the same static bundle validation and save workflow. The
existing App store validates and retains the bundle. Include `index.html` and
non-empty `context.md`; all dependencies must be local. The limit is 200 files
and 8 MiB encoded. Credential filenames and unsafe paths are rejected. Review
file contents for secrets before saving.

A save creates a working context document, a draft App with no Hub capability
grants, and an immutable outcome trace with a bundle hash. It returns document
and App IDs, a relative `documentUrl`, and a `receipt`. Keep the receipt and
pass it back with `files` on subsequent calls to revise the same artifact.
Unchanged bundles reuse the existing version. Set `publish: true` explicitly to
publish context and activate the App; otherwise review and publish in the Hub
UI.

Errors after partial work include a recovery receipt. Retain it and follow its
pending-stage guidance; document creation with an unknown outcome requires
recovering the document ID before retrying. A lost MCP response can also lose
the receipt: find the created document/App in Hub before retrying. Calls without
a receipt or explicit target start a new artifact; they are not globally
idempotent. Publication and activation remain separate operations. See the
[artifact guide](codex-artifacts.md) for sandbox and portability limits.

## Pull an existing artifact

On a fresh machine, use `artifact.get` with `documentId` (and `appId` when
multiple Apps exist). It returns `context` using the `documents.get` visibility
rule, `files` mapping paths to `{type, data}` base64 data URLs, `version`,
`appId` and `digest` (bundle SHA-256). Editors receive the latest draft files;
readers receive only activated files. The same 200-file / 8 MiB bundle limit
applies.

To revise via MCP, pass `documentId` and `appId` together to `artifact.save`
instead of a receipt; the returned `files` map can be passed directly. The App
must belong to that editable document. CLI users can pull into a new directory
and retain the generated receipt:

```sh
deno task artifact:pull https://hub.example/knowledge/DOCUMENT_ID ./artifact
deno task artifact:save ./artifact
```

Use `OKF_HUB_URL` when passing an ID instead of a URL, and `OKF_HUB_TOKEN` with
`artifact.get` and `documents.get` scopes for pulling. Saving still needs the
scopes listed above. Pull refuses an existing destination to avoid stale files
and symlink overwrites. Unchanged pulled bundles reuse the same version.

## Transport limits

This is a stateless JSON-response implementation of
[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
It supports initialize, ping, tools/list, tools/call, and notifications, with
protocol versions 2025-06-18 and 2025-11-25. GET and DELETE return 405; there
are no sessions, SSE streams, resources, prompts, or server-initiated requests.
POST requests must accept both `application/json` and `text/event-stream`.
Request bodies are capped at 9 MiB. Browser Origin headers must match the
endpoint origin.

Tool results include JSON `structuredContent` as well as legacy text content.
Stable object results declare `outputSchema`; both advertised protocol versions
support these fields. Array results are wrapped as `{result: [...]}` in
structured content while text retains the original JSON.

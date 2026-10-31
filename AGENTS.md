# Working on OKF Hub

OKF Hub is a self-hosted Deno/React knowledge hub. Read the relevant module and
tests before changing behavior; preserve unrelated work.

## Architecture

- `server/main.ts` wires the HTTP routes, collaboration, stores and shared
  operations. Put new logic in focused modules and keep changes here small.
- `server/action-catalog.ts` projects one action implementation into HTTP,
  OpenAPI, MCP (`server/mcp.ts`) and the App bridge. Register new agent
  operations in the catalog, including schemas and scopes.
- `server/security.ts` owns authentication, scoped keys and OpenFGA
  authorization. Reuse its checks and existing operation helpers; do not invent
  parallel permission rules.
- `server/document-frontmatter.ts` preserves extension frontmatter in SQLite
  separately from controlled fields. The server combines it into portable
  Markdown in the object store for drafts, publications and exports.
- `server/search-index.ts` maintains SQLite FTS5 rows for drafts, published
  revisions and imports. Search intersects candidates with visible documents.
- `server/semantic-index.ts` maintains optional embedding chunks with versioned
  background indexing. Retrieval must filter permission and document state
  before building the context budget.
- `server/artifact-store.ts` retains App bundles and versions;
  `server/app-capabilities.ts` issues short-lived, version-pinned capability
  URLs for opaque sandbox frames. These tokens grant file reads, not Hub
  actions.
- `src/` contains the React UI. `integrations/` contains agent instructions: the
  Claude SKILL body and Codex AGENTS body must remain identical.

## Commands and conventions

- `deno task test`: TypeScript, production build, lint, then Deno tests.
- `deno fmt` / `deno fmt --check`: formatting.
- `deno task dev`: Vite UI; `deno task dev:service`: watched backend.
- `deno task stack`: local Docker Compose stack; `deno task stack:down` stops
  it.
- `deno task admin`: operator administration; inspect its help before use.
- Docs pages under `docs/` need valid OKF frontmatter; index/log have their own
  formats. Follow neighboring pages and `tests/docs_test.ts`.
- `server/main_test.ts` provides a fake OpenFGA server that evaluates test
  tuples. Keep permission tests meaningful using its deny hook where needed. The
  audit assertion compares the latest 50 events exactly: account for new events
  rather than weakening that assertion.

## Local testing safety

Use a separate temporary `OKF_DATA_DIR` or an isolated Compose project for
experiments. Never alter the operator's running stack, data, credentials or
services to make tests pass. Never use `pkill`; stop only processes you started
and can identify. Do not commit secrets or generated local stack configuration.

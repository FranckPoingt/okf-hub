---
type: Guide
title: OKF Hub beta user guide
description: Start, navigate, and operate the self-hosted OKF Hub beta.
tags: [okf-hub, beta, self-hosting]
status: stable
---

# OKF Hub beta docs

This is the user-facing starting point for the current OKF Hub beta.

If you want the documentation map, read the [OKF bundle index](index.md). The
product overview and roadmap live in [README.md](../README.md) and
[PLAN.md](../PLAN.md). For Artifacts and connector internals, see the
[extensibility model](extensibility.md).

## Start here

1. Sign up or sign in to create an account. On a fresh install, open the
   one-time setup link that `deno task stack` and the server log print; the
   first account can only be created through it.
2. If this is the first account in a new install, complete the onboarding screen
   to create and name the workspace.
3. If you were invited, open the invitation link, sign in or create your
   account, and accept the invitation to join the existing workspace. Once a
   workspace exists, new account signup requires a matching pending invitation.
   A configured OIDC or SAML provider follows the same invitation flow.
4. Open **Home** to see recent knowledge, unpublished drafts, and connected
   sources.
5. Use **Search** to find accessible knowledge across hub-native documents and
   imported sources.
6. Create a **Space** for a team, area, or policy boundary.
7. Create a document inside a space, write in the draft view, then **Publish**
   when it is ready for readers.
8. Use **Sources** to connect Git repositories, S3-compatible storage, or
   Notion.
9. Open **Workspace settings** to manage workspace identity, members, templates,
   connectors, and developer access.
10. If an AI provider is configured, use **Ask OKF** to ask questions grounded
    in the open document or, from Search, in accessible knowledge across
    sources.

## Navigation

- **Home**: quick overview of recent documents, drafts, and source health.
- **Search**: permission-aware search with filters for type, tag, ownership,
  review status, and archived content.
- **Spaces**: grouped knowledge with inherited access rules.
- **Artifacts**: a gallery of the Artifacts you can open, workspace-wide or per
  space, with trust and review state. An Artifact document opens full-bleed;
  **View context** shows its document, and **Open as document** edits it.
- **Sources**: connected imports, sync status, schedules, and source issues.
- **Workspace settings**: workspace identity, spaces, members, templates,
  connectors, export, and the Developer API.
- **Document view**: draft/published toggle, comments, references, revision
  history, presentation mode, and Artifacts.

## Core concepts

### Workspace

The workspace is the top-level container for the installation. The first account
in a fresh install creates and names it during onboarding, and invited users
join that existing workspace through an invitation link.

It holds the name, tagline, logo, members, templates, spaces, and developer
access.

### Spaces

Spaces group related documents and carry the default access boundary. They are
the main way to separate policies, teams, and operating areas.

### Hub-native knowledge

Hub-native documents are authored inside OKF Hub. They start as private drafts,
can be published into versioned revisions, and can be archived and restored
later.

Published revisions are what readers see. Drafts stay editable until you publish
the next revision.

### Ownership and review

Each hub-native document can have a responsible workspace editor and an optional
next review date. New documents belong to their creator; existing documents stay
unassigned until an editor chooses an owner. Assigning responsibility does not
grant access to the document.

Open the document's ownership and review settings to assign an owner, set a
calendar deadline, or clear it. These settings are shared immediately with
people who can read the document and remain separate from unpublished writing.

To record a review, open **Published** and choose **Mark revision N reviewed**.
The hub records who checked that exact revision and when. Choose today or a
future review date or clear an expired deadline before marking the revision
reviewed. Reviews are advisory and do not block publication or publish draft
changes.

A reviewed revision stays reviewed while its draft changes. Publishing a new
revision requires another review. A review deadline lasts through its UTC
calendar day; the following day it becomes overdue. With no deadline, the hub
shows the recorded review date without inventing an expiry.

**Home → Needs attention** collects maintained, published documents that need an
owner or review, plus documents you can edit that went stale because a source or
dependency changed. Search also exposes ownership and review filters. Editors
see a separate **Draft changes** label when search shows unpublished writing
beside the review status of its publication. Drafts and source connection
failures remain separately identifiable.

Review status and trust stay separate in the data and API, but the UI shows one
**Needs attention** badge when either applies: a review that is due, overdue or
missing (from the ownership and review settings above), or stale code or
dependencies (from sources, described in
[Freshness and ownership](#freshness-and-ownership)). Its tooltip lists every
reason. **Sync failed** is a source error, so it keeps its own badge. A reviewed
document still needs attention when a document in its `sources:` goes stale, and
a stale reason never names a source you cannot view.

Which owner is shown:

- **Hub-native documents**: the responsible member chosen in the hub. This
  setting is the only owner the hub uses for search, filters, and **Needs
  attention**. An `owner:` key in the document's frontmatter is kept unchanged
  through drafts, publishing, and export as an OKF extension field. The hub does
  not read it as the responsible member.
- **Imported concepts**: the source's own `owner:` frontmatter, or, if it has
  none, the owners that `CODEOWNERS` gives for the file (see below). Imported
  concepts have no responsible member in the hub.

### Source-owned knowledge

Imported knowledge stays read-only in the hub. Current source types are:

- Git repositories containing an OKF folder;
- S3-compatible storage;
- Notion pages shared with an internal integration.

Imported content keeps provenance, revision history, and sync status. If a
source changes or fails, the hub keeps the last healthy import and shows the
source issue instead of silently overwriting local knowledge. **Snapshot
updated** shows when imported content changed; **Source checked** shows the last
successful source check. A successful source check is separate from a human
review.

#### Source access

Workspace owners choose who can see each source under **Sources → Connected →
Access**:

- **Everyone in the workspace** (the default for every source, including ones
  connected before this setting existed): every member can read the source;
  workspace editors can suggest changes and draft OKF.
- **Selected members and groups**: only workspace owners and the members or
  groups you add can find, read, or ask about the source. **Viewers** read it.
  **Editors** can also suggest changes and draft OKF. Workspace editors who are
  not listed lose access too, so a private repository stays private.

Access is enforced by the authorization service on the source's imported space,
which every imported document inherits. Search, the company graph, link
previews, Ask OKF, MCP and API actions, artifact staleness reasons, and the
artifact gallery all hide a restricted source from people outside it, without
revealing that it exists. Switching back to **Everyone in the workspace**
restores member access and clears the list. Each change is recorded in the audit
log as `source.access_restricted`, `source.access_opened`,
`source.access_granted`, or `source.access_revoked`.

The owner-only `GET /api/sources/:id/access` endpoint returns
`{ mode: "workspace" | "restricted", grants: [{ type: "user" | "group", id, role: "viewer" | "editor" }] }`.
Replace it with `PUT` and the same shape. Repeating a `PUT` changes nothing.

### Company relationships and disagreements

Open a native or imported concept to see **References and backlinks** and **Also
defined in**. These span Git, shared storage, Notion, and native documents, and
show only definitions you can access. The native **References** panel can insert
a portable cross-source link.

The Hub does not guess whether two definitions disagree. Editors judge that with
[Compare definitions](#compare-definitions) from the **Also defined in** group,
then resolve disagreements through the owning team's normal authoring workflow.
The Hub never rewrites or merges definitions.

Use `[label](okf://<source-slug>/<concept-path>)` to reference another source,
or give related concepts the same frontmatter `id` to group them. Matching types
and normalized titles also group automatically. Read the exact link, ID,
and permission rules in
[OKF conformance](okf-conformance.md#cross-source-references-and-shared-entities).
A missing or inaccessible link displays only its label.

### Freshness and ownership

A Git-imported concept can declare the code it explains with the `describes:`
extension field, a list of repository-relative globs:

```yaml
---
type: Guide
title: Billing rules
describes: [src/billing/**, db/migrations/*billing*.sql]
---
```

On every successful sync (webhook, manual, or scheduled), the hub compares the
previously imported revision with the new one. If a described path changed and
the concept file did not, the concept is marked stale; the **Needs attention**
tooltip shows the commit range and up to ten changed paths. Publishing an update
to the concept file clears it. A failed sync, a first import, or a missing
previous revision never marks anything stale.

Each sync also reads the repository's `CODEOWNERS` (`.github/`, the root, then
`docs/`, as GitHub does; the last matching rule wins). A concept without an
`owner` field takes the owners of its own file, and a concept with `describes:`
also lists the code owners of the described paths.

Hub documents, especially Artifacts, can list the concepts they were built from
in `sources:` frontmatter, using a hub document id or `/knowledge/<id>` link, an
imported concept id, or an imported path such as `billing.md`. When any of them
is stale, archived, or deleted, the dependent document shows **Needs attention**
with the reason “Depends on …” in its view and in search. Other `sources:`
entries, such as external URLs, are kept as citations and are not tracked.

### Ask OKF

Ask OKF is an optional read-only assistant for hub-native and source-owned
documents. It answers from the open document or, when workspace scope is
selected, relevant accessible knowledge across sources. It cannot edit, publish,
approve, or run actions. The same document permission check applies before any
content is sent to the configured provider; editors may ask about drafts while
viewers receive published content only.

Open Ask OKF from Search for workspace questions, or switch scope inside a
document. Workspace answers include links to the retrieved sources. Retrieval
can miss relevant material; check the sources.

**Default retrieval.** Search, Ask OKF and the MCP `knowledge.search` tool use a
SQLite FTS5 full-text index ranked with BM25, stored privately in the app's
`hub.db`. Words match their stems and prefixes ("paying" finds "payment"), and
exact title matches still rank first. The index keeps hub drafts, hub
publications and current imports as separate rows, and every search intersects
its matches with the documents the user can view: viewers match publications,
editors match the drafts they can edit, and restricted sources stay hidden. For
workspace questions, Ask OKF first asks the chat provider for 3–10 search terms
and synonyms. That call sends **only the question and recent chat turns**, never
document content. If it fails, returns invalid JSON, or takes longer than about
8 seconds, Ask OKF falls back to the question's keywords.

**Optional embeddings.** Hybrid retrieval also finds paraphrases with embeddings
and combines the keyword and semantic rankings with reciprocal rank fusion,
keeping the same context budget and source citations. It is off by default.

Asking a question sends the selected document or a bounded selection of
accessible source content and recent chat messages to that provider. Choose and
configure a provider that meets your organisation's data-handling requirements.

Configure the provider on the server in the ignored `.okf-stack.env` file, then
restart the app:

```sh
OKF_AI_PROVIDER=<ax-provider-id>
OKF_AI_MODEL=<provider-model-id>
OKF_AI_API_KEY=<provider-api-key>
# Optional for compatible or self-hosted endpoints:
OKF_AI_URL=<provider-api-url>
# Optional: enable hybrid retrieval with an embedding model:
OKF_AI_EMBED_MODEL=<embedding-model-id>
# Optional: use a different embedding endpoint (each defaults to the chat value):
OKF_AI_EMBED_PROVIDER=<ax-provider-id>
OKF_AI_EMBED_URL=<embedding-api-url>
OKF_AI_EMBED_API_KEY=<embedding-api-key>
```

Ax provider IDs include `openai`, `anthropic`, `google-gemini`, `openrouter`,
`groq`, and `ollama`. For example, Ollama Cloud uses `ollama`, its model ID,
`https://ollama.com/v1`, and the Ollama key as `OKF_AI_API_KEY`. The legacy
`OLLAMA_API_KEY` variable remains a fallback for existing installations.

Open **Workspace settings → AI** to confirm the server configuration is ready.
Provider credentials are never sent to the browser.

Embeddings use `OKF_AI_EMBED_PROVIDER`, `OKF_AI_EMBED_URL` and
`OKF_AI_EMBED_API_KEY`; each unset value reuses the chat provider's
`OKF_AI_PROVIDER`, `OKF_AI_URL` or `OKF_AI_API_KEY`. Supported embedding
providers are `openai` and `google-gemini` (through Ax, for example
`text-embedding-3-small` with `openai`) and `ollama` (through Ollama's native
`/api/embed`). Other providers, including `anthropic`, stay keyword-only. An
unset model or unsupported provider keeps keyword retrieval without errors.
Compatible self-hosted endpoints can use the `openai` adapter with an explicit
`OKF_AI_EMBED_URL`.

When embeddings are enabled, **every indexed document is sent to the embedding
endpoint** in the background: hub drafts, published revisions, and current
imports, including restricted sources and documents some members cannot view.
Requests contain document titles and chunks of roughly 1–2k characters;
workspace questions are also sent for embedding. Answers still send only the
questioner's accessible content to the chat provider: viewers match
publications, editors match drafts they can already edit, and restricted sources
are filtered using the same view permission checks as keyword search.

The recommended setup is local
[EmbeddingGemma](https://ollama.com/library/embeddinggemma) through Ollama, so
document content never leaves your infrastructure, whichever chat provider you
use. Compose includes an optional `ollama` service behind the `embeddings`
profile, with models kept in the `ollama_data` volume:

```sh
docker compose --profile embeddings up -d
docker compose exec ollama ollama pull embeddinggemma
```

Then add to `.okf-stack.env` and restart the app (`COMPOSE_PROFILES` makes
`deno task stack` start Ollama too):

```sh
COMPOSE_PROFILES=embeddings
OKF_AI_EMBED_PROVIDER=ollama
OKF_AI_EMBED_URL=http://ollama:11434
OKF_AI_EMBED_MODEL=embeddinggemma
```

Vectors, chunk text, content hashes, and a resumable work queue are stored in
the app's SQLite `hub.db` (`okf_semantic_document` and `okf_semantic_chunk`),
inside `OKF_DATA_DIR` or the Docker app-data volume. They are private server
data, included in normal data backups; no API exposes vectors or hidden chunks.
Publishing and source sync invalidate changed versions immediately, draft saves
are debounced, and deleted concepts or imports lose their index rows. Access
restrictions take effect at retrieval time without waiting for reindexing.

Indexing starts after startup, processes at most two documents concurrently in
batches of eight chunks, and retries failures with backoff (up to five minutes).
Pending work survives restart. Until indexing catches up, keyword results remain
available; query embedding failures fall back to keyword retrieval. Changing the
embedding model or endpoint rebuilds vectors in the background. Removing
`OKF_AI_EMBED_MODEL` stops embedding requests and restores keyword-only
retrieval; existing private index data remains in SQLite.

### Artifacts

Artifacts are separate from the document body. They are sandboxed, versioned
tools attached to a concept and activated only after review by a workspace owner
or a manager of the document's space (see [Space managers](#space-managers)).

Artifacts can call only the actions they are explicitly granted. Their data
stays isolated from the parent document and from other Artifacts.

See [docs/extensibility.md](extensibility.md) for the current Artifact model and
developer surface.

### Connectors

Connectors are the owner-managed provider entries under **Sources** and
**Workspace settings**. The current catalog includes:

- Git repository import;
- S3-compatible storage import;
- Notion import;
- Miro preview embeds;
- Google Sheets preview embeds.

Owners can enable or disable connectors without deleting existing content.
Disabling a connector stops new connections and syncs.

## Data portability and security

- Exporting the workspace or a space downloads portable ZIP data.
- Hub-native content exports as Markdown; Artifacts export with their approved
  files.
- Source-owned imports and private Artifact data stay with their original
  systems and users.
- Permissions are enforced on direct URLs, search, previews, APIs, and exports.
- Connector credentials are write-only in the UI and stored encrypted by the
  service.
- Self-hosted OIDC and SAML login is configured outside the repository; see
  [Self-hosted SSO](sso.md).
- Ordinary Markdown does not execute raw HTML.

## Operate the self-hosted stack

The default Docker configuration binds the application to `127.0.0.1:8788`. Put
a trusted HTTPS reverse proxy in front of it before exposing it beyond the host,
then set `OKF_BASE_URL` and `BETTER_AUTH_TRUSTED_ORIGINS` in `.okf-stack.env` to
the public origin.

Create a consistent backup of application data, OpenFGA state, and object
storage:

```sh
deno task stack:backup
```

The command briefly stops the data services and writes a timestamped archive
under the ignored `backups/` directory. Copy that archive to storage outside the
host.

Restore one of those archives only after confirming the destructive operation:

```sh
deno task stack:restore backups/okf-hub-<timestamp>.tgz --yes
```

The restore command replaces the three persisted volumes and restarts the stack.
SSO secrets in `config/private/`, `config/sso.json`, GitHub App keys, and
`.okf-stack.env` are host configuration and must be backed up separately.

Set `OKF_BOOTSTRAP_OWNER_EMAIL=you@example.com` in `.okf-stack.env` (or the
server environment) to pin your own email as a workspace owner. On every start
the server makes sure that account exists and is an owner, and prints a one-time
sign-in link when it had to create or promote it. It never demotes anyone, so it
is safe to leave set.

## Recover access

Whoever has shell or Docker access to the server is the host operator and can
always regain owner access without wiping data. `deno task admin` uses the
running Docker stack when there is one, and otherwise the local data directory
(`OKF_DATA_DIR`, default `.okf-data`) used by `deno task dev:service`. Force a
target with `--stack` or `--local`.

```sh
deno task admin users                         # email, name, owner, created
deno task admin login-link you@example.com    # one-time sign-in link, 15 minutes
deno task admin reset-password you@example.com
deno task admin make-owner you@example.com
deno task admin create-owner you@example.com --name "Your Name"
deno task admin setup-url                     # first-run link while no account exists
```

`reset-password` and `create-owner` print a temporary password once, sign the
account out everywhere, and ask for a new password at the next sign-in. A login
link signs in without a password. If the account's email was never verified,
Better Auth removes its old password when the link is used; run `reset-password`
afterwards to set one. On a fresh install with no workspace yet, `create-owner`
and `make-owner` leave ownership to the workspace setup step, which that account
completes at first sign-in.

Every command is recorded in the audit log with the actor `host-operator`. The
commands open the server's database directly and are never served over HTTP;
anyone who can run them could already read the data volume. In the hub, owners
can promote other members to owner or remove their owner role from **Workspace
settings → Members**. A workspace always keeps at least one owner, and former
owners keep editor access.

### Local testing with AI agents

An agent that creates the first account with a random email and password locks
the human out of that hub. Give agents their own data directory, such as
`OKF_DATA_DIR=.okf-data/agent OKF_PORT=8789 deno task dev:service` (manage it
with `OKF_DATA_DIR=.okf-data/agent deno task admin --local users`), or recover
afterwards with `deno task admin create-owner you@example.com`.

## What this beta does not promise yet

- Managed cloud hosting.
- Multi-region high availability.
- A generic connector marketplace.
- Arbitrary server-side plugins.
- Native desktop packaging.

## Draft knowledge for a repository

When a connected repository's selected OKF folder is missing or empty, source
editors and owners can choose **Draft an OKF bundle** in Sources. Configure the
server AI provider first; the action is hidden without one. When connecting a
GitHub repository without an OKF folder, choose `okf` to propose a new folder.

Drafting sends a bounded selection of README files, documentation, ADRs,
CODEOWNERS, package manifests, and top-level names to that provider. Hidden,
secret/key/credential paths, symlinks, oversized files, and arbitrary source
files are excluded. Documentation can still contain sensitive text: review your
repository documentation and provider data-handling policy before drafting. The
selection is limited to 32 files, 12 KB per file, 48 KB total, five directory
levels and 1,000 visited entries. This selection may omit relevant evidence.

Review the file list, rendered Markdown, provenance, and any dropped invalid
concepts in the Hub. Generated concepts remain drafts and cite the repository
paths used. Nothing is imported or published by drafting. Drafts expire after 30
minutes and are persisted in the app SQLite database across server restarts. Up
to 32 pending drafts are retained. Approval applies to the exact reviewed draft.

For GitHub App sources, approval creates a new branch and a **draft pull
request**. The default branch is never written to. If the base revision has
changed, regenerate and review the proposal. The Artifact needs repository
**Contents: Read and write** (`contents:write`) and **Pull requests: Read and
write** (`pull_requests:write`), in addition to metadata read access and
**Push** and **Pull request** (`pull_request`) webhook subscriptions on
`/api/webhooks/github`. The signed Pull request events update suggestion status
on close, merge and reopen, deduplicated by delivery. Update existing Artifact
registrations and approve the new permissions on installations. `stack:github`
configures credentials; it does not modify the GitHub App's permission settings.

For manual HTTPS Git sources, approval downloads a ZIP rooted at the configured
OKF folder. Submit it through your repository's normal review process. Drafting,
proposal creation, downloads and failures are recorded in the audit trail.
GitHub failures after branch creation trigger best-effort deletion of that
proposal branch. If cleanup also fails, an unused branch may remain; inspect
GitHub before retrying. The Hub never merges the proposal.

## Suggest a change to imported knowledge

Imported concepts are read-only mirrors: the repository stays authoritative.
Editors of the imported source's space (and owners) see **Suggest a change** on
a concept from a connected Git repository. No Git knowledge is needed: edit the
Markdown body in the Hub editor, review the diff, add a short reason and submit.
Frontmatter is preserved and cannot be edited here.

For GitHub App sources, submitting creates a new branch and a **draft pull
request** that changes only that concept file. The pull request describes your
reason, your Hub display name, and links back to the concept; `@mentions` in
your text are neutralized so nobody is notified unexpectedly. The Hub copy does
not change until the pull request is merged and the source next syncs (push
webhook, schedule or manual refresh). The concept shows "1 open suggestion" with
a link; signed Pull request webhooks update its status on close, merge and
reopen. Source sync also refreshes open suggestions as a fallback.

The suggestion must be based on the revision you edited. If the concept was
re-synced meanwhile, or the repository default branch has moved since the last
sync, the Hub refuses and asks you to refresh and apply the edit again; it never
rebases for you. The concept path must lie inside the source's OKF folder. The
default branch is never written to. This uses the same Artifact permissions as
drafting (`contents:write`, `pull_requests:write`).

For manual HTTPS Git sources there is no write access, so the Hub downloads a
`git format-patch`-style patch instead; apply it with `git am` (or `git apply`)
and submit it through your normal review process. Suggestions are recorded in
the audit trail as `source.change-proposed` (pull request) or
`source.change-patch-exported` (patch).

## Space managers

Workspace owners can add and remove managers in **Workspace settings → Spaces →
Managers**. Choose a workspace member for each space. Managers can activate
Artifacts in that space; ordinary editors cannot. Workspace owners retain
activation access. This role does not grant general workspace ownership.

The owner-only `GET /api/spaces/:id/managers` endpoint returns
`{ managers: [userId, ...] }`. Assign or revoke with `PUT` or
`DELETE /api/spaces/:id/managers/:userId`.

## Compare definitions

With an AI provider configured, editors can choose **Compare definitions** in
the **Also defined in** group or References sheet. Both definitions must still be visible
to the requesting editor and belong to the same cross-source group. The
read-only comparison sends up to 12,000 characters per definition (plus bounded
labels) to the configured provider as untrusted evidence, and returns a short
explanation of material agreement or disagreement. Shortened input is marked.
Review the originals: AI output is advisory, never changes a source, and is
recorded as `knowledge.definitions-compared` in the audit trail.

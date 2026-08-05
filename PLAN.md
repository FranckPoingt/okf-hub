# OKF Knowledge Hub — Product Plan and Initial Backlog

## Purpose

Build a self-hostable company knowledge hub that combines knowledge from many authoritative sources while allowing teams to author company-level knowledge in a friendly, collaborative editor.

The hub is a unified, permission-aware view over:

- **Imported OKF sources:** each codebase or connected source remains authoritative for its own OKF bundle.
- **Hub-native OKF:** policies, onboarding, decisions, glossary entries, and other company knowledge authored in the product.

The product is not a new proprietary knowledge format. OKF Markdown remains portable and exportable; the hub supplies the collaboration, governance, discovery, and automation layer that the format intentionally does not prescribe.

## Product principles

1. **Many sources, one company view.** Every concept shows its source, owner, and freshness.
2. **Visual authoring, portable output.** Non-technical users work in a rich editor; published hub-native pages become valid OKF Markdown.
3. **Customer-controlled by default.** The full installation, storage, metadata, permissions, and logs can stay in the customer's chosen environment and region.
4. **Permissions before discovery.** Search, graph traversal, previews, automations, agents, and exports enforce the same access decision.
5. **Automation proposes; people govern.** Automated work creates a reviewable proposal, diff, provenance record, and audit event.
6. **Keep the first product narrow.** Git repositories and one shared object store are the only source types in the initial release.

## Primary user and first release job

The first user is an operations, product, or engineering-adjacent writer at an engineering-led company with several code repositories.

They need to find trusted knowledge across those repositories, create company-level documentation without learning Git or Markdown, connect it to technical context, and keep it current without a separate knowledge silo.

## Lifecycle and governance

Use three independent dimensions rather than one complex state machine:

| Dimension | Values |
| --- | --- |
| Content | `draft`, `published`, `archived` |
| Review | `not required`, `requested`, `approved`, `changes requested` |
| Trust | `current`, `verified`, `stale`, `sync failed`, `source missing` |

Hub-native pages have a private working draft. Publishing produces a canonical OKF revision in customer storage. Imported pages are read-only mirrors: every successful source sync creates an imported revision and never overwrites a hub-native draft.

## Information architecture

```text
Organisation
├── Sources
│   ├── Repository source (OKF folder)
│   └── Shared-store source (company OKF)
├── Knowledge spaces
│   ├── Imported concepts
│   └── Hub-native concepts
└── Relationships
    ├── ownership and source provenance
    ├── links, tags, types, and references
    └── access relationships
```

Spaces and sources are the normal permission boundary. Individual document restrictions are supported as exceptions and inherit down the page hierarchy.

## Technical direction

| Area | Initial decision |
| --- | --- |
| Web app | React + Vite, responsive PWA |
| Runtime and service layer | Deno with Effect; native Deno HTTP server |
| Identity | Better Auth for sessions, users, organisations, and invitations |
| Authorization | Self-hosted OpenFGA from the first release |
| Application metadata | SQLite on a persistent volume |
| Authorization metadata | OpenFGA with SQLite on its own persistent volume |
| Knowledge and attachments | Customer-controlled S3-compatible object storage; RustFS is the local default; Azure Blob adapter later |
| Repository sync | Git provider webhooks with CLI/polling fallback |
| Editor candidate | Milkdown, with CommonMark + GFM and collaborative CRDT support |
| Live collaboration | CRDT document state over WebSockets; Markdown is generated at checkpoint/publish time |
| Search | Permission-filtered lexical search first; semantic search later |

### Storage and source contract

The initial object-storage contract is S3-compatible storage, covering RustFS, AWS S3, Cloudflare R2, and Google Cloud Storage interoperability. Azure Blob Storage is a separate adapter when demand requires it.

Source connectors report a stable source identifier, sync cursor, content revision, validation results, owner, and errors. They must be safe to retry and must not silently delete a previously indexed concept when a source becomes temporarily unavailable.

### Permission model

- Better Auth proves identity and organisation membership.
- OpenFGA decides access to organisations, groups, sources, spaces, documents, drafts, and artifacts.
- The application writes factual relationships to OpenFGA as entities change; it does not duplicate permission logic in route handlers.
- Restricted concepts are excluded from search, graph results, suggestions, previews, AI retrieval, and automation inputs.

### Markdown profile

The authored profile is CommonMark plus selected GitHub-Flavored Markdown:

- headings, links, lists, task lists, tables, quotes, code blocks, footnotes, and strikethrough;
- Mermaid and math as explicit supported extensions;
- no raw HTML execution inside ordinary Markdown.

The editor exposes only blocks that round-trip cleanly into the profile. Imported Markdown outside the profile remains readable, with validation warnings rather than destructive conversion.

## Later extension: interactive artifacts

Do not embed arbitrary HTML in an OKF document body. Add a typed, versioned interactive artifact later.

An artifact may contain reviewed inline HTML or an approved HTTP(S) application reference. It is rendered in a sandboxed iframe, inherits the host concept's OpenFGA policy, is versioned and auditable, and is only made live after review. This leaves a safe path for AI- or human-created dashboards, calculators, diagrams, and mini-apps while preserving portable OKF as the document layer.

## Explicitly out of scope for the first release

- Managed cloud hosting and multi-region operation.
- Enterprise SSO/SCIM and WorkOS integration.
- Azure Blob Storage adapter.
- Semantic/vector search and AI answers.
- Native desktop packaging and full mobile authoring.
- Arbitrary HTML, external app embeds, or AI-generated mini-apps.
- A universal ontology editor or a generic connector marketplace.
- Multi-instance high availability.

## Risks and validation gates

| Risk | Gate |
| --- | --- |
| Rich editor loses Markdown fidelity | Prove import, visual edit, collaborative edit, publish, and re-import across the supported profile. |
| Real-time collaboration complicates self-hosting | Prove two-user CRDT editing, reconnect, snapshot recovery, and Markdown publication in a single-node install. |
| Source sync is unreliable | Prove webhook, retry, rename, deletion, invalid OKF, and source-unavailable behavior. |
| Permission rules leak restricted knowledge | Prove denial through direct URL, search, graph, previews, automation, and source sync. |

## Backlog

Each item is a thin vertical slice with UI, service behavior, persistence, and verification. `AFK` means it can be implemented without a product decision; `HITL` requires a decision or review from the product owner.

### Epic 1 — Product shell

#### KH-02 — Run the editor and collaboration proof

- **Type:** AFK
- **Blocked by:** None
- **What to build:** A disposable React/Vite and Deno prototype using Milkdown that imports supported Markdown, allows two people to edit concurrently, reconnects, and exports the resulting Markdown.
- **Acceptance criteria:**
  - [x] CommonMark + GFM content round-trips without loss for the supported profile.
  - [x] Two collaborators see cursor and text updates.
  - [x] A reconnect restores the latest document state.
  - [x] The result is stored and reopened as canonical Markdown.

#### KH-03 — Ship a self-hosted local installation

- **Type:** AFK
- **Blocked by:** KH-02
- **What to build:** A one-command local deployment containing the Deno application, OpenFGA, persistent volumes, and RustFS storage configuration.
- **Acceptance criteria:**
  - [x] A new installation starts with no cloud dependency.
  - [x] Data and authorization state survive restart.
  - [x] Backup and restore instructions are tested.
  - [x] Services use least-privilege credentials and do not expose internal admin endpoints.

### Epic 2 — Identity, authorization, and knowledge lifecycle

#### KH-04 — Establish organisation access and source permissions

- **Type:** AFK
- **Blocked by:** KH-03
- **What to build:** Login, invitations, groups, source/space roles, and OpenFGA-backed authorization checks for viewing and editing a concept.
- **Acceptance criteria:**
  - [x] An owner can invite an editor and viewer.
  - [x] Access is granted through group membership at source/space level.
  - [x] Restricted concepts are inaccessible through direct URLs and listing APIs.
  - [x] Permission changes are recorded in an audit trail.

#### KH-05 — Create the hub-native OKF lifecycle

- **Type:** AFK
- **Blocked by:** KH-04
- **What to build:** Create, autosave, publish, archive, restore, and revision history for one hub-native OKF concept.
- **Acceptance criteria:**
  - [ ] Authors edit a visual draft without seeing YAML or Markdown by default.
  - [ ] Publishing emits conformant OKF Markdown to customer storage.
  - [ ] Published content remains visible while a new draft is edited.
  - [ ] Archive removes routine discovery but preserves history and restore.

#### KH-06 — Add review, provenance, and freshness status

- **Type:** AFK
- **Blocked by:** KH-05
- **What to build:** Optional approval requests, concept owners, review due dates, source provenance, and stale indicators.
- **Acceptance criteria:**
  - [ ] A policy space can require review before publication.
  - [ ] Review decisions and comments are recorded against a revision.
  - [ ] A concept can become stale without changing its published content state.
  - [ ] A reviewer can see why a concept is stale or trustworthy.

### Epic 3 — Connected sources and unified discovery

#### KH-07 — Import one repository-owned OKF source

- **Type:** AFK
- **Blocked by:** KH-04
- **What to build:** Connect a Git repository and folder, validate its OKF, import concepts, display source provenance, and update through a webhook with retry fallback.
- **Acceptance criteria:**
  - [ ] A repository owner maps an OKF directory through the UI or CLI.
  - [ ] Imported concepts are visibly read-only and identify their source revision.
  - [ ] Invalid files report actionable validation errors without blocking healthy concepts.
  - [ ] Renamed, deleted, and temporarily unavailable source files receive distinct status handling.

#### KH-08 — Import the shared controlled knowledge store

- **Type:** AFK
- **Blocked by:** KH-07
- **What to build:** Connect an S3-compatible bucket and path as a shared OKF source, with the same validation, provenance, and retry behavior as repositories.
- **Acceptance criteria:**
  - [ ] The owner configures endpoint, bucket, path, and credentials.
  - [ ] The hub indexes a shared OKF bundle without GitHub dependence.
  - [ ] The source status reports last successful sync and any error.
  - [ ] Credentials are encrypted and never returned to the browser.

#### KH-09 — Deliver permission-aware unified search and relationships

- **Type:** AFK
- **Blocked by:** KH-05, KH-07, KH-08
- **What to build:** One lexical search and browse experience across hub-native and imported concepts, with type/tag filters, backlinks, and source/owner status.
- **Acceptance criteria:**
  - [ ] Results never reveal inaccessible concepts.
  - [ ] Users can distinguish imported from hub-native concepts.
  - [ ] Links and relationship views show provenance and trust status.
  - [ ] Archived concepts are excluded by default and optionally discoverable by authorised users.

### Epic 4 — Automation and product hardening

#### KH-10 — Add safe source and freshness automation

- **Type:** AFK
- **Blocked by:** KH-06, KH-09
- **What to build:** Scheduled source checks, broken-link detection, stale-review tasks, and a review queue.
- **Acceptance criteria:**
  - [ ] A source failure does not mark unrelated sources failed.
  - [ ] Automatic work is retry-bounded and observable.
  - [ ] Automation proposes actions and never silently rewrites a published concept.
  - [ ] Operators can inspect jobs, failures, and retry history.

#### KH-11 — Add an optional enterprise identity connector

- **Type:** HITL
- **Blocked by:** KH-04
- **What to build:** A WorkOS-backed SSO and directory-sync adapter that maps identity-provider groups into existing OpenFGA relationships.
- **Acceptance criteria:**
  - [ ] Self-hosted Better Auth remains the default.
  - [ ] An administrator can enable enterprise SSO without changing document policies.
  - [ ] Directory changes map predictably to organisation groups.

#### KH-12 — Add sandboxed interactive artifacts

- **Type:** HITL
- **Blocked by:** KH-06, KH-09
- **What to build:** Typed, reviewed HTML and URL artifacts attached to concepts, rendered in a sandboxed iframe with the concept's access policy.
- **Acceptance criteria:**
  - [ ] Ordinary Markdown never executes HTML.
  - [ ] Artifacts require explicit type, review, and versioning.
  - [ ] The renderer blocks unsafe script/network capabilities by default.
  - [ ] Artifact access, previews, and audit events follow OpenFGA decisions.

## Development order

Start with KH-02 and build through KH-05. At that point, a team can sign in, edit a real company document collaboratively, publish portable OKF, and control access. Add repository and shared-store import next, then unified search and freshness automation. Enterprise identity and interactive artifacts remain deliberate follow-on releases.

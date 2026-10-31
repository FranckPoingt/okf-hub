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
[PLAN.md](../PLAN.md). For Apps and connector internals, see the
[extensibility model](extensibility.md).

## Start here

1. Sign up or sign in to create an account.
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
10. If an AI provider is configured, use **Ask OKF** on any document to ask
    questions grounded in that document.

## Navigation

- **Home**: quick overview of recent documents, drafts, and source health.
- **Search**: permission-aware search with filters for type, tag, and archived
  content.
- **Spaces**: grouped knowledge with inherited access rules.
- **Sources**: connected imports, sync status, schedules, and source issues.
- **Workspace settings**: workspace identity, spaces, members, templates,
  connectors, export, and the Developer API.
- **Document view**: draft/published toggle, comments, references, revision
  history, presentation mode, and Apps.

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

### Source-owned knowledge

Imported knowledge stays read-only in the hub. Current source types are:

- Git repositories containing an OKF folder;
- S3-compatible storage;
- Notion pages shared with an internal integration.

Imported content keeps provenance, revision history, and sync status. If a
source changes or fails, the hub keeps the last healthy import and shows the
source issue instead of silently overwriting local knowledge.

### Ask OKF

Ask OKF is an optional read-only assistant for hub-native and source-owned
documents. It answers from the open document only and cannot edit, publish,
approve, or run actions. The same document permission check applies before any
content is sent to the configured provider; editors may ask about drafts while
viewers receive published content only.

Asking a question sends the open document content and recent chat messages to
that provider. Choose and configure a provider that meets your organisation's
data-handling requirements.

Configure the provider on the server in the ignored `.okf-stack.env` file, then
restart the app:

```sh
OKF_AI_PROVIDER=<ax-provider-id>
OKF_AI_MODEL=<provider-model-id>
OKF_AI_API_KEY=<provider-api-key>
# Optional for compatible or self-hosted endpoints:
OKF_AI_URL=<provider-api-url>
```

Ax provider IDs include `openai`, `anthropic`, `google-gemini`, `openrouter`,
`groq`, and `ollama`. For example, Ollama Cloud uses `ollama`, its model ID,
`https://ollama.com/v1`, and the Ollama key as `OKF_AI_API_KEY`. The legacy
`OLLAMA_API_KEY` variable remains a fallback for existing installations.

Open **Workspace settings → AI** to confirm the server configuration is ready.
Provider credentials are never sent to the browser.

### Apps

Apps are separate from the document body. They are sandboxed, versioned tools
attached to a concept and activated only after review.

Apps can call only the actions they are explicitly granted. Their data stays
isolated from the parent document and from other Apps.

See [docs/extensibility.md](extensibility.md) for the current App model and
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
- Hub-native content exports as Markdown; Apps export with their approved files.
- Source-owned imports and private App data stay with their original systems and
  users.
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
minutes or server restart. Approval applies to the exact reviewed draft.

For GitHub App sources, approval creates a new branch and a **draft pull
request**. The default branch is never written to. If the base revision has
changed, regenerate and review the proposal. The App needs repository
**Contents: Read and write** (`contents:write`) and **Pull requests: Read and
write** (`pull_requests:write`), in addition to metadata read access and
existing push webhook subscriptions. Update existing App registrations and
approve the new permissions on installations. `stack:github` configures
credentials; it does not modify the GitHub App's permission settings.

For manual HTTPS Git sources, approval downloads a ZIP rooted at the configured
OKF folder. Submit it through your repository's normal review process. Drafting,
proposal creation, downloads and failures are recorded in the audit trail.
GitHub failures after branch creation may leave an unused proposal branch;
inspect GitHub before retrying. The Hub never merges the proposal.

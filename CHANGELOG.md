# Changelog

## Unreleased

### Upgrade notes

- The OpenFGA authorization model upgrades itself at startup (a versioned
  migration adds the space `manager` relation and per-source access); there is
  no manual step. Back up before upgrading.
- `OKF_BOOTSTRAP_OWNER_EMAIL` (optional) pins an email as a workspace owner on
  every start. `deno task admin` is the new host-operator command for listing
  users, minting one-time sign-in links, resetting passwords, and creating or
  promoting owners. See [Recover access](docs/README.md#recover-access).
- GitHub App sources that use the new draft-OKF and suggest-a-change features
  need the App's **Contents: Read and write** and **Pull requests: Read and
  write** permissions approved on every installation, and the **Pull request**
  webhook event enabled on `/api/webhooks/github` (alongside **Push**).
  `deno task stack:github` does not change these App settings; update them in
  GitHub.

### Behavior changes

- **The first account needs the setup link.** While no workspace exists, account
  creation requires the one-time link that `deno task stack` and the server log
  print (or `deno task admin setup-url`). Sign-up on a fresh install is no
  longer open.
- **SSO cannot create the first account.** Create it with the setup link or
  `deno task admin create-owner`, then invite SSO users.
- **Workspace editors lose access to restricted sources.** Owners can restrict a
  source to selected members and groups; editors who are not listed lose access
  too. Existing sources stay open to the whole workspace until an owner
  restricts them.
- **App files are served from capability URLs.** The App iframe loads from
  `/app-files/<token>/<path>`, a 10-minute, per-user, per-version URL that needs
  no cookie. The cookie-authenticated `/api/apps/:id/files/*` route is unchanged
  but is no longer what the sandbox loads.
- **Module scripts are allowed in Apps.** Local `<script type="module">` and
  relative `import`s now pass validation. Remote, bare, and root specifiers,
  dynamic `import()`, and network APIs are still rejected.
- **App activation is no longer owner-only.** Workspace owners and managers of
  the document's space can activate an App; ordinary editors cannot.

### Artifacts

- Save a static artifact (`index.html` plus a required `context.md`) from the
  CLI (`deno task artifact:save`), MCP (`artifact.save`), or **Upload artifact**
  in a space. A save creates a working document, a draft App with no Hub grants,
  and an immutable work trace; a receipt makes revisions idempotent.
- `--vendor` downloads allow-listed CDN dependencies, including nested ES
  modules, on the saving machine and records them in `vendor.json`.
- An artifact-first view opens an `Artifact` document's App full-bleed with
  **View context** and **Open as document**, plus a permission-filtered
  **Artifacts** gallery for the workspace and for each space.
- Second-use measurement: the Hub counts, in its own database, distinct people
  other than the creator who open an artifact, and shows owners the artifacts
  reused in the last 30 days. This measures reuse; it does not show that teams
  benefit from it.

### Knowledge across sources

- `okf://<source>/<path>` links, shared frontmatter `id`s, and matching type and
  title connect definitions across Git, shared storage, Notion, and native
  documents, with **Also defined in** and backlinks limited to what the viewer
  can access.
- A lexical check flags **Potential definition conflicts**; editors can list
  them workspace-wide from Search. With an AI provider, **Compare definitions**
  adds an advisory explanation. Nothing is merged or rewritten.
- Ask OKF can answer from relevant accessible knowledge across sources
  (workspace scope) as well as from one document. Providers are configurable
  through Ax (`OKF_AI_PROVIDER`, `OKF_AI_MODEL`, `OKF_AI_API_KEY`,
  `OKF_AI_URL`).
- **Draft an OKF bundle**: with an AI provider, editors can have a draft bundle
  generated for a repository that has none. GitHub App sources get a draft pull
  request; manual Git sources get a ZIP. Reviewed drafts persist across
  restarts.
- **Suggest a change** on an imported Git concept opens a draft pull request
  (GitHub App) or exports a patch. Signed `pull_request` webhooks update the
  suggestion's status.

### Governance & freshness

- Hub documents have a responsible owner and an optional review date. A human
  review records the exact published revision, reviewer, and time; reviews are
  advisory.
- Imported Git concepts can declare `describes:` globs and become **stale** when
  the described code changes. `CODEOWNERS` supplies owners.
- Documents that list `sources:` show **stale: depends on …** when a dependency
  goes stale, is archived, or is deleted. Stale reasons never name a source the
  reader cannot view.
- **Home → Needs attention** includes stale documents with their reason.
- Native OKF frontmatter (`sources`, `describes`, `owner`, `tags`, and unknown
  fields) is preserved through drafts, publishing, and export.
- Document writing, templates, and the Ask surface were reworked, with a draft
  review before publishing.

### Access & administration

- Owners restrict a source to selected members and groups (**Sources → Connected
  → Access**), enforced in OpenFGA and audited.
- Workspace owners assign space managers.
- Host operators can always recover owner access with `deno task admin`.
- Every member manages their own API keys from the developer page; a key never
  exceeds its user's access. **Workspace settings** is hidden from members who
  cannot edit.

### Integrations

- Scoped MCP access at `/api/mcp` (Streamable HTTP, stateless; Developer API
  keys read accessible knowledge and save artifacts), plus a Claude Code skill
  and a Codex `AGENTS.md` snippet in [`integrations/`](integrations/README.md)
  that teach an agent to save artifacts.
- Release automation: pushing a semantic-version tag runs the tests and creates
  the GitHub Release.

### Fixes

- Typed `[label](url)` becomes a link in the editor, limited to allowlisted
  schemes; inserting a page reference keeps its link.
- Magic-link requests are blocked regardless of path casing or slashes.
- Invitation lookup finds the signed-in user's pending invitation and lists only
  pending invitations.
- Exported document names stay unique for ids sharing a long prefix.
- Quoted published types are read with the YAML parser.
- Proposal branch cleanup keeps slashes in branch names; suggested-change
  patches are built under the data directory.
- The Docker image includes every server-imported `src` file.
- The mobile artifact sheet wraps the sandbox badge.

## 0.1.0 - 2026-08-20

Initial public beta of OKF Hub:

- self-hosted Deno, React, OpenFGA, SQLite, and S3-compatible stack;
- Markdown-first hub-native documents with collaboration and publishing;
- read-only Git, GitHub App, S3-compatible, and Notion sources;
- permission-aware search, spaces, invitations, SSO, Apps, and developer
  actions;
- OKF v0.2-conformant published documents, documentation, and ZIP exports.

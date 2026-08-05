# OKF Hub

Product prototypes for the OKF Knowledge Hub.

## KH-02 collaboration proof

Run the current service stack with `deno task stack`. For frontend development, keep that service running and start Vite with `deno task dev`.

The service stores draft and Yjs state in its application data volume; published revisions live in RustFS. `deno task test` verifies the production build, editor shell, lifecycle, and owner/editor/viewer authorization paths.

For the single-process production proof, run `deno task build` followed by `deno task start`; the native Deno server serves both the app and collaboration API on port 8788.

## KH-03 local installation

Run `deno task stack` to build and start the Deno app, OpenFGA with SQLite, and RustFS. Only the app is exposed, at `http://127.0.0.1:8788`; OpenFGA and RustFS stay on the internal Docker network. Local credentials are generated once in the ignored `.okf-stack.env` file.

Stop the stack without deleting data with `deno task stack:down`. Create a consistent backup with `deno task stack:backup`, then restore one with `deno task stack:restore backups/<file>.tgz --yes`. Restore stops the data services and only restarts them after a successful extraction.

Keep `.okf-stack.env` in a separate secure backup; data archives exclude those stack service credentials. Archives do include encrypted connected-source credentials and their local decryption key, so protect backups as sensitive data.

This first installation uses single-node RustFS, which has no storage redundancy. Move to multi-node RustFS when the deployment needs host-failure tolerance.

## KH-04 organisation access

Open `http://127.0.0.1:8788` and create the first account; it becomes the organisation owner. The owner can create local invitation links for Policy editors and Policy viewers under **Manage access**. Invitees use the invited email address, open the link, and accept membership in the corresponding Better Auth team.

OpenFGA grants editor access through the source-level editor group and viewer access through the Policies space viewer group. Direct concept reads, writes, listings, and collaboration sockets all enforce the same decision. The owner can inspect permission changes in the access panel audit trail.

## KH-05 hub-native lifecycle

Authors work in a private, autosaved visual draft. **Publish** writes a versioned OKF Markdown revision to RustFS while viewers remain on the last published revision. **History** can restore any published revision as a new draft; **Archive** removes the concept from routine discovery without deleting its history, and **Restore concept** reverses that action.

## KH-07 repository source

The organisation owner can connect one public HTTPS Git repository and repository-relative OKF folder under **Repository**. The hub validates YAML frontmatter and the required `type`, stores each healthy source revision in RustFS, and renders imported concepts as visibly read-only with their path and commit provenance. Invalid files are isolated as actionable source issues; exact renames, deletions, and source failures are reported without deleting the last healthy imports. **Refresh repository** is the retry/update path.

The Docker image includes Git. Install `git` separately when running `deno task start` outside Docker. Private-repository credentials and provider webhooks are intentionally deferred until manual refresh is insufficient.

## KH-08 shared controlled store

The organisation owner can also connect one S3-compatible endpoint, bucket, and OKF path under **Sources**. The hub lists and validates Markdown without GitHub, copies each healthy source revision into its revision store, and keeps the last healthy imports available when a refresh fails. S3 credentials are write-only in the browser API and AES-GCM encrypted in SQLite with a generated `source-credentials.key` stored at mode `0600` in the application data volume.

Use **Refresh shared store** to retry or index a changed bundle. The connector uses path-style S3 requests and the standard AWS Signature Version 4 credential format; RustFS, AWS S3, R2, and other compatible endpoints can use their normal endpoint and region values.

## KH-09 unified search and relationships

Open **Search** to browse hub-native, Git, and shared-store concepts together. Lexical search covers titles, types, owners, tags, and Markdown content; type and tag filters are derived only from concepts the current user can view. Results identify their source, owner, lifecycle/trust status, links, and backlinks.

Every search candidate and relationship target passes the same OpenFGA concept check as direct reads. Archived hub-native concepts stay out of normal results; authorised editors can opt into them with **Include archived**. Imported content is re-indexed on source refresh, and existing imports receive a startup metadata backfill from their stored revision.

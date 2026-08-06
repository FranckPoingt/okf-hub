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

Open `http://127.0.0.1:8788` and create the first account; it becomes the organisation owner. The owner can create local invitation links for knowledge editors and viewers under **Manage access**. Invitees use the invited email address, open the link, and accept membership in the corresponding Better Auth team.

OpenFGA grants editor access through the source-level editor group and viewer access through space-level viewer relationships. Direct concept reads, writes, listings, and collaboration sockets all enforce the same decision. The owner can inspect permission changes in the access panel audit trail.

## KH-05 hub-native lifecycle

Authors work in a private, autosaved visual draft. **Publish** writes a versioned OKF Markdown revision to RustFS while viewers remain on the last published revision. **History** can restore any published revision as a new draft; **Archive** removes the concept from routine discovery without deleting its history, and **Restore concept** reverses that action.

## KH-07 repository source

The organisation owner can connect one HTTPS Git repository and repository-relative OKF folder under **Repository**. Public repositories need no credentials; private repositories accept a Git username and HTTPS access token. The hub validates YAML frontmatter and the required `type`, stores each healthy source revision in RustFS, and renders imported concepts as visibly read-only with their path and commit provenance. Invalid files are isolated as actionable source issues; exact renames, deletions, and source failures are reported without deleting the last healthy imports. **Refresh repository** is the retry/update path.

Private-repository credentials are write-only in the browser API and AES-GCM encrypted with the same local `source-credentials.key` used by shared-store credentials. Git receives a host-scoped authorization header through its child-process environment, so tokens are not stored in the remote URL or command arguments. The Docker image includes Git; install it separately when running `deno task start` outside Docker. Provider webhooks remain deferred until manual refresh is insufficient.

## KH-08 shared controlled store

The organisation owner can also connect one S3-compatible endpoint, bucket, and OKF path under **Sources**. The hub lists and validates Markdown without GitHub, copies each healthy source revision into its revision store, and keeps the last healthy imports available when a refresh fails. S3 credentials are write-only in the browser API and AES-GCM encrypted in SQLite with a generated `source-credentials.key` stored at mode `0600` in the application data volume.

Use **Refresh shared store** to retry or index a changed bundle. The connector uses path-style S3 requests and the standard AWS Signature Version 4 credential format; RustFS, AWS S3, R2, and other compatible endpoints can use their normal endpoint and region values.

## KH-09 unified search and relationships

Open **Search** to browse hub-native, Git, and shared-store concepts together. Lexical search covers titles, types, owners, tags, and Markdown content; type and tag filters are derived only from concepts the current user can view. Results identify their source, owner, lifecycle/trust status, links, and backlinks.

Every search candidate and relationship target passes the same OpenFGA concept check as direct reads. Archived hub-native concepts stay out of normal results; authorised editors can opt into them with **Include archived**. Imported content is re-indexed on source refresh, and existing imports receive a startup metadata backfill from their stored revision.

## KH-10 source automation

Organisation owners can inspect and run source checks under **Sources → Checks and proposals**. The in-process scheduler checks each connected source independently every 15 minutes, records every attempt, retries a failed source once, and leaves unrelated sources running. Set `OKF_AUTOMATION_INTERVAL_MS=0` to disable scheduled runs.

Each run also scans authorised imported concepts for broken internal Markdown links. Findings are stored as `fix_broken_link` proposals for operators; automation never changes hub-native drafts or published revisions. Review-date tasks remain deferred with KH-06.

## KH-12 interactive artifacts

Editors can attach versioned inline HTML or HTTPS applications to a hub-native concept. Owners explicitly make a draft version live; viewers only receive live artifacts, and every artifact request inherits the concept's OpenFGA access decision. Artifacts remain separate from portable Markdown.

Inline HTML runs in an `allow-scripts` iframe with network, nested frames, objects, forms, and top-level navigation blocked. HTTPS applications must use an exact hostname listed in the comma-separated `OKF_ARTIFACT_ALLOWED_HOSTS` setting; leaving it empty disables URL artifacts.

## KH-13 spaces and documents

Editors can create knowledge spaces and hub-native documents from **Spaces → Manage**. Each document has its own Markdown draft, Yjs collaboration state, publication history, lifecycle, and interactive artifacts. Search results and sidebar navigation open the selected document.

OpenFGA links each concept to its space and each space to the hub source. Editors inherit edit access from the source; viewers inherit view access from each space and only see published, active concepts. Existing Incident communication files remain at their original paths during migration.

## KH-14 document management and export

Editors can rename or move a hub-native document under **Document settings**. A move swaps the concept's OpenFGA parent while retaining its stable ID, Markdown draft, Yjs state, published revisions, artifacts, and audit history. **Spaces → Manage** supports space renaming and deletion only after every active or archived document has been moved out; the default Policies space cannot be deleted.

**Download OKF** returns the current published revision with canonical frontmatter as a Markdown attachment. Draft-only documents remain unavailable to viewers, archived documents remain unavailable to viewers, and exports never substitute the mutable working draft for the published object.

## KH-15 Home dashboard

**Home** provides a permission-filtered overview using the same concept, space, import, and source responses already loaded by the app. It shows recent accessible documents, knowledge-space and imported totals, unpublished and archived counts for editors, and connected-source health without introducing a separate dashboard index.

Recent items open their existing document views. **Search knowledge**, **Create document**, and the connected-source health card route to the current search, creation, and source-management flows.

## KH-16 shareable navigation

The app uses the browser History API for stable routes without a routing dependency: `/` for Home, `/search`, `/sources`, `/manage`, `/knowledge/<concept-id>`, and `/imports/<source>/<path>`. Nested imported paths are encoded segment by segment so links remain readable and reversible.

Direct URLs wait for authentication and the initial permission-filtered lists, then call the same concept or import API used by in-app navigation. Browser back and forward replay those loaders. Inaccessible, malformed, and unknown paths all render the same generic unavailable page.

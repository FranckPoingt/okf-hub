# OKF Hub

Product prototypes for the OKF Knowledge Hub.

## KH-02 collaboration proof

Run the current service stack with `deno task stack`. For frontend development, keep that service running and start Vite with `deno task dev`.

The service stores canonical Markdown and Yjs state in its application data volume. `deno task test` verifies the production build, editor shell, and owner/editor/viewer authorization paths.

For the single-process production proof, run `deno task build` followed by `deno task start`; the native Deno server serves both the app and collaboration API on port 8788.

## KH-03 local installation

Run `deno task stack` to build and start the Deno app, OpenFGA with SQLite, and RustFS. Only the app is exposed, at `http://127.0.0.1:8788`; OpenFGA and RustFS stay on the internal Docker network. Local credentials are generated once in the ignored `.okf-stack.env` file.

Stop the stack without deleting data with `deno task stack:down`. Create a consistent backup with `deno task stack:backup`, then restore one with `deno task stack:restore backups/<file>.tgz --yes`. Restore stops the data services and only restarts them after a successful extraction.

Keep `.okf-stack.env` in a separate secure backup; data archives intentionally exclude credentials.

This first installation uses single-node RustFS, which has no storage redundancy. Move to multi-node RustFS when the deployment needs host-failure tolerance.

## KH-04 organisation access

Open `http://127.0.0.1:8788` and create the first account; it becomes the organisation owner. The owner can create local invitation links for Policy editors and Policy viewers under **Manage access**. Invitees use the invited email address, open the link, and accept membership in the corresponding Better Auth team.

OpenFGA grants editor access through the source-level editor group and viewer access through the Policies space viewer group. Direct concept reads, writes, listings, and collaboration sockets all enforce the same decision. The owner can inspect permission changes in the access panel audit trail.

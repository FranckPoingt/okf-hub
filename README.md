# OKF Hub

Product prototypes for the OKF Knowledge Hub.

## KH-02 collaboration proof

Run `deno install`, start the collaboration service with `deno task dev:service`, then start the web app with `deno task dev`. Open the collaborator button to exercise two-user editing and reconnect recovery.

The service stores canonical Markdown and Yjs state in `.okf-data/`. Verify the production build, server-rendered shell, Markdown persistence, two-client sync, and reconnect with `deno task test`.

For the single-process production proof, run `deno task build` followed by `deno task start`; the native Deno server serves both the app and collaboration API on port 8788.

## KH-03 local installation

Run `deno task stack` to build and start the Deno app, OpenFGA with SQLite, and RustFS. Only the app is exposed, at `http://127.0.0.1:8788`; OpenFGA and RustFS stay on the internal Docker network. Local credentials are generated once in the ignored `.okf-stack.env` file.

Stop the stack without deleting data with `deno task stack:down`. Create a consistent backup with `deno task stack:backup`, then restore one with `deno task stack:restore backups/<file>.tgz --yes`. Restore stops the data services and only restarts them after a successful extraction.

Keep `.okf-stack.env` in a separate secure backup; data archives intentionally exclude credentials.

This first installation uses single-node RustFS, which has no storage redundancy. Move to multi-node RustFS when the deployment needs host-failure tolerance.

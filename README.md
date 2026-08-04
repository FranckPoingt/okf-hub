# OKF Hub

Product prototypes for the OKF Knowledge Hub.

## KH-02 collaboration proof

Run `deno install`, start the collaboration service with `deno task dev:service`, then start the web app with `deno task dev`. Open the collaborator button to exercise two-user editing and reconnect recovery.

The service stores canonical Markdown and Yjs state in `.okf-data/`. Verify the production build, server-rendered shell, Markdown persistence, two-client sync, and reconnect with `deno task test`.

For the single-process production proof, run `deno task build` followed by `deno task start`; the native Deno server serves both the app and collaboration API on port 8788.

# OKF Hub

Product prototypes for the OKF Knowledge Hub.

## KH-02 collaboration proof

Run the Deno collaboration service with `npm run dev:service`, then run the web app with `npm run dev`. Open the collaborator button to exercise two-user editing and reconnect recovery.

The service stores canonical Markdown and Yjs state in `.okf-data/`. Verify the production build, server-rendered shell, Markdown persistence, two-client sync, and reconnect with `npm test`.

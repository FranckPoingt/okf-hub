---
type: Guide
title: Save a Codex artifact in OKF Hub
description: Retain and revise static AI creations with their context and portable files.
tags: [okf-hub, artifacts, codex, portability]
status: beta
---

# Save a Codex artifact in OKF Hub

Keep a useful Codex-generated dashboard, explanation, calculator, or other
interactive artifact in a company-owned Hub, alongside the knowledge needed to
understand and maintain it. This first workflow supports self-contained static
web files. It preserves the files you created and uses the existing App review
and version lifecycle.

## Prepare the artifact

Ask Codex to create a dedicated artifact folder containing only the files you
intend to share, with:

- `index.html`, containing the interactive surface;
- `context.md`, explaining its purpose, owner, sources, assumptions, inputs,
  outputs, limitations, and what would require an update;
- any local JavaScript, CSS, images, fonts, or datasets it needs.

Use ordinary browser JavaScript and local assets. The Hub sandbox blocks network
calls, external scripts, nested frames, and form submission. Bundle dependencies
locally; use relative module imports and avoid browser storage that relies on a
normal page origin. Both the server and saver reject common unsupported
dependencies, but code still needs review and a browser check. The `context.md`
heading supplies the title unless you pass `--title`.

Dotfiles, `node_modules`, credential files such as `credentials.json`,
`secret.json`, `auth.json`, and `api-key.json`, and key files are excluded.
Review the remaining files before saving: a filename filter cannot detect a
secret embedded in JavaScript or a dataset. A bundle can contain at most 200
regular files and its encoded size must fit the Hub's 8 MiB limit. Symlinks are
rejected.

## Upload from the Hub

In a space where you can create documents, select **Upload artifact**. Choose
one `.html` file or a `.zip` of static files with `index.html` at its root. A
single HTML file becomes `index.html`. ZIP uploads can include `context.md`; its
YAML title or first heading supplies the document title. If it is absent, the
dialog asks for a title and description and generates minimal OKF context.
Uploads create a working Artifact document and a draft App with no Hub grants.
Publish the context and activate the App through the usual review workflow.

Uploads do not fetch dependencies. The server applies the same dependency checks
as the CLI, before creating the document. CDN dependencies produce an error with
a CLI hint. ZIPs may use stored or deflated files; encrypted archives, symlinks,
unsafe or duplicate paths, unsupported file types, and oversized bundles are
rejected. Put files directly at the ZIP root, without a containing folder.

## Vendor CDN dependencies on your machine

For an artifact with external scripts, styles, fonts, or ESM imports:

```sh
deno task artifact:save /absolute/path/to/artifact --space "Team knowledge" --vendor
```

Downloads happen only on the saving machine, never in the Hub or the browser.
The command accepts HTTPS URLs on `cdn.jsdelivr.net`, `unpkg.com`,
`cdnjs.cloudflare.com`, `esm.sh`, `fonts.googleapis.com`, and
`fonts.gstatic.com`. Redirects must stay on that allowlist. It includes
downloaded files under `vendor/` in the saved bundle, rewrites references
relative to each file, and adds `vendor.json` with `{url, path, sha256}`
records. SHA-256 covers the final stored bytes, including rewritten CSS. The
work trace identifies the manifest and includes it in the bundle hash. The
source folder stays unchanged.

Use single-file ESM outputs, such as esm.sh `?bundle` or jsdelivr `/+esm`, and
relative imports after rewriting. A CDN response that itself imports another
module is rejected with the source and nested URL; some CDN bundle endpoints
still return wrappers, so supply the actual single-file output in that case. CSS
font URLs and stylesheet imports are vendored recursively. Network APIs, dynamic
imports, and runtime downloads remain unsupported. A runtime Tailwind loader may
need replacing with precompiled CSS. Vendoring does not compile JSX, install npm
packages, or guarantee an artifact runs correctly; review dependency licenses
and test the saved App. The sandbox and CSP are unchanged.

The 200-file and 8 MiB encoded bundle limits include downloaded dependencies and
`vendor.json`. Without `--vendor`, remote dependencies are rejected with a hint
to use the flag. Export retains the rewritten files and manifest.

## Connect once

Sign into your Hub and open **Developer API** in the profile menu. Create a key
with these scopes:

```text
spaces.list
documents.create
documents.get
documents.update-draft
documents.trace.create
apps.list
apps.create
apps.revise
```

If you also want the command to publish, add `documents.publish` and
`apps.activate`. Activation still requires the key's user to be a workspace
owner. A key never grants more access than that user already has.

Set your Hub URL and enter the key into the shell without putting it in history:

```sh
export OKF_HUB_URL=http://okf-hub.localhost
read -rs 'OKF_HUB_TOKEN?Paste your Hub API key: '
export OKF_HUB_TOKEN
```

This input command is for zsh, the default macOS shell. Keep the key in a secret
store or an ignored environment file for subsequent sessions. The saver reads it
only from `OKF_HUB_TOKEN`; there is no token command-line argument, and neither
the bundle nor the local receipt contains it. Use HTTPS for a remote Hub.

## Save and reopen

From the OKF Hub repository:

```sh
deno task artifact:save /absolute/path/to/artifact --space "Team knowledge"
```

You can use `--space-id` instead of an exact space name, and `--hub` instead of
`OKF_HUB_URL`. If only one space is editable, the space option is optional.

The command creates a working `Artifact` knowledge document, saves `context.md`
as its draft, attaches the static App with no granted Hub capabilities, and
records an immutable outcome trace with the bundle hash. It prints the knowledge
document's URL. Open that URL and select **Apps** to use the artifact; the
context document is also available through ordinary Hub search.

Saving defaults to a draft. To publish the context and activate the App:

```sh
deno task artifact:save /absolute/path/to/artifact --space "Team knowledge" --publish
```

The owner can also publish the document and activate the App in the Hub UI.
Readers see published context and activated versions. The saver checks
publication scopes and owner access before publishing. Context publication and
App activation are two separate requests; if activation fails after context
publication, rerun the command to finish activation.

## Revise the same artifact

Edit the original folder with Codex and run the same command again. The ignored
`.okf-artifact.json` receipt remembers the Hub, space, document, and App IDs. An
unchanged folder keeps its current App version; changed files create a new draft
version of the same App. The live version remains available until activation.
Each distinct bundle produces one work trace, including `context.md` in the
hash.

Keep the receipt with that local folder. A receipt from another Hub or space is
rejected. Copy the artifact files into a new folder without the receipt if you
intend to create a separate artifact.

If a command fails, rerun it. Completed steps are checkpointed, and retries
reconcile an App, revision, or trace whose response was lost. If a document
creation response was lost before its ID could be recorded, the command stops
instead of creating another document. Find the created document in the Hub and
add its ID to the receipt's `documentId` field before retrying. If an App could
not be identified after a lost creation response, add its `appId` in the same
way. Do not delete the receipt merely to work around an error.

## Export the proof

Use the Hub's space or workspace ZIP export. It includes the OKF context and the
artifact's original static files, including `context.md`. Extract the ZIP and
open the exported `index.html` to check that this self-contained artifact
remains usable outside the Hub. The receipt and API key are excluded.

This proves portability of the static files and context. It does not yet export
Hub App data, package a server runtime, or automatically translate artifacts
from other providers. Persistent shared records and their schema migrations need
a separate storage and portability contract.

## First dogfood

`examples/sovereign-artifact` contains an interactive explanation of our own
product direction and the context Codex produced alongside it. The API
integration exercises save, unchanged retry, a new draft version, activation,
reader discovery, and export of the original files and conformant OKF context.
The explanation also runs inside the Hub's actual static App sandbox.

This demonstrates the retention workflow with disposable test users and storage.
It does not establish that a team will reuse the artifact or that reuse will
improve its work. The next product experiment should test that second use. The
current Hub still opens the document first and places the creation behind
**Apps**; an artifact-oriented experience should let people open the useful
creation directly and consult its context when needed.

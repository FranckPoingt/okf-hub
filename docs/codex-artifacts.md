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
locally; avoid module imports, CDN dependencies, and browser storage that relies
on a normal page origin. The saver rejects common unsupported dependencies, but
code still needs review and a browser check. The `context.md` heading supplies
the title unless you pass `--title`.

Dotfiles, `node_modules`, credential files such as `credentials.json`,
`secret.json`, `auth.json`, and `api-key.json`, and key files are excluded.
Review the remaining files before saving: a filename filter cannot detect a
secret embedded in JavaScript or a dataset. A bundle can contain at most 200
regular files and its encoded size must fit the Hub's 8 MiB limit. Symlinks are
rejected.

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
`apps.activate`. Activation requires the key's user to be a workspace owner or a
manager of the artifact's space; plain editors cannot activate. A key never
grants more access than that user already has.

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

An owner or space manager can also publish the document and activate the App in
the Hub UI. Readers see published context and activated versions. The saver
checks publication scopes and activation access before publishing. Context
publication and App activation are two separate requests; if activation fails
after context publication, rerun the command to finish activation.

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

## Measure second use

The Hub records, in its own database, when someone opens an activated version of
an `Artifact` document's static App (at most once per person per artifact per
hour). Nothing leaves your deployment. For each artifact it derives:

- distinct people other than the creator who opened it, in the last 30 days and
  all time (the creator is whoever added the document's first App);
- App versions and published document revisions saved by someone other than the
  creator;
- when it was last opened.

Editors and managers see these counts above the artifact's Apps. Workspace
owners also see, on Home, how many artifacts were reused by others in the last
30 days, with a short list. The Hub exposes counts only, never who opened an
artifact. Hosted-URL Apps and inline-HTML Apps without a file bundle are not
counted.

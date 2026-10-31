## Save artifacts to OKF Hub

## When to use

Use this when the user asks to save an artifact to the hub ("save this to the
hub", "share this artifact with the team"), or after you built an interactive
artifact (explanation, dashboard, calculator) they want to keep. Do not save
anything the user has not asked to keep; saving creates a draft in the Hub.

## Steps

1. **Build a self-contained folder** containing only files to share:
   `index.html`, `context.md`, and any local JS, CSS, images, fonts, or data.
   - No network calls, no CDN tags, no nested frames, no form submission. Use
     classic scripts or ES modules with relative specifiers (`./app.js`), never
     bare (`react`) or root (`/app.js`) ones.
   - Avoid `localStorage`/cookies; the page has no normal origin.
   - Compile JSX first. Vendoring does not compile or install npm packages.
   - Max 200 regular files, 8 MiB encoded. No symlinks, dotfiles,
     `node_modules`, or credential/key files. Check that no secret is embedded
     in scripts or data.
2. **Write `context.md`** (see `examples/sovereign-artifact/context.md` in the
   okf-hub repo). Start with a `# Title` heading (it becomes the document
   title). Optional YAML frontmatter: `title`, `owner`, `status`, `created`.
   Sections:
   - Purpose: what it explains or computes, and for whom.
   - Owner: a named person or team, as the user told you. Never invent one.
   - Sources: where claims and data come from, linking Hub or repo concepts as
     `okf://...` links or document ids. Use only ids you actually found, e.g.
     via `knowledge.search`; say "none" otherwise.
   - Assumptions, inputs and outputs (including embedded data and its date).
   - Limitations, and what would require an update (which source changing should
     trigger review).
   - Evidence: label honestly what is first-hand, quoted, estimated, or
     unverified. Do not invent authority, metrics, or citations; separate
     accepted decisions from hypotheses.
3. **Save.**
   - If the Hub MCP server is connected (`okf-hub` in Claude Code, `okf_hub` in
     Codex), call `artifact.save` with `spaceId` (find it with `spaces.list`; it
     must be editable, and may be omitted only when you can edit exactly one
     space) and `files` mapping relative paths to UTF-8 text (or base64 data
     URLs for binaries). `files` must include `index.html` and a non-empty
     `context.md`. If CDN assets are used, the MCP route cannot vendor them:
     inline or fetch them locally first.
   - Otherwise, from the okf-hub repository with `OKF_HUB_TOKEN` and
     `OKF_HUB_URL` set:
     `deno task artifact:save /abs/path/to/folder --space "Space name" --vendor`
     (`--vendor` downloads allow-listed CDN dependencies on this machine).
   - Never ask the user to paste the API key into chat.
4. **Revise, don't duplicate.** On later edits, change the same folder and save
   again. CLI: the `.okf-artifact.json` receipt in the folder links the save to
   the same document; keep it, and never delete it to dodge an error. MCP: keep
   the `receipt` from the result and pass it back with `files` (it must come
   from an MCP save, not the CLI). Without a receipt a new artifact is created.
5. **Report** the Hub URL (CLI prints it; MCP returns a relative `documentUrl`,
   so prefix the origin of the MCP server URL, e.g. from `claude mcp get`).
   State that it is saved as a draft with no Hub capabilities until someone
   publishes and activates it in the Hub, unless the user asked for `--publish`
   / `publish: true` (this needs extra scopes and owner/manager access).

## Checklist

- [ ] `index.html` and non-empty `context.md` exist at the folder root
- [ ] Works offline: no URLs fetched at runtime, dependencies local
- [ ] Module imports are relative; no dynamic imports of remote code
- [ ] No secrets, no credential filenames, under 200 files / 8 MiB
- [ ] `context.md` has owner, sources, assumptions, limitations, update
      triggers, and honest evidence
- [ ] Opened in a browser or checked for obvious errors
- [ ] Saved with the receipt/folder of any earlier version
- [ ] Hub URL reported to the user

## Common errors

| Error                                                       | Fix                                                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Artifact folder needs index.html` / `non-empty context.md` | Add the missing file at the folder root.                                                                                                               |
| `Excluded artifact file` / `unsafe filename`                | Remove dotfiles, `node_modules`, credential or key files; rename unsafe paths.                                                                         |
| `Unsupported static file`                                   | Keep to web assets (html, css, js, json, images, fonts, text).                                                                                         |
| `Artifact exceeds 8 MiB` / `exceeds 200 files`              | Drop unused files, shrink or compress data and images.                                                                                                 |
| `Artifact dependency must be included locally`              | CLI: rerun with `--vendor`. MCP: bundle the file locally. Hosts outside the allow-list must be downloaded by hand.                                     |
| `ES module dependency must be included locally`             | Bare (`react`) or root (`/app.js`) module specifier: use relative `./file.js` imports and bundle the dependency.                                       |
| `references must be relative (./file), not root paths`      | Change `src="/app.js"`, `href="/app.css"` or `url(/x.png)` to `./app.js` style paths.                                                                  |
| `Artifact title must be 1–100 characters`                   | Fix the `# heading` in `context.md`, or pass `--title` (CLI) or `title` (MCP). No heading: the document is named `Artifact`.                           |
| `Choose space or spaceId`                                   | You passed both `space` and `spaceId`; pass one.                                                                                                       |
| `Choose exactly one editable space`                         | Pass the `spaceId` of an editable space from `spaces.list`.                                                                                            |
| `Use the receipt returned by this Hub MCP action`           | The receipt came from the CLI; save without it, or use the receipt of an MCP save.                                                                     |
| 401/403 or missing `artifact.save` tool                     | The key lacks scopes; see docs/mcp.md. All save scopes are required.                                                                                   |
| Save failed midway                                          | Rerun the same command; the receipt resumes completed steps. If the document id was lost, find it in the Hub and put it in the receipt's `documentId`. |

Full details: `docs/codex-artifacts.md` and `docs/mcp.md` in the okf-hub repo.

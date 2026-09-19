# OKF Hub

OKF Hub is a self-hostable, Markdown-first knowledge hub for company knowledge
spread across documents, repositories, and connected sources.

> [!WARNING]
> OKF Hub is beta software. Expect breaking changes and back up your data before
> upgrading.

## What it does

- Keeps hub-native documents as portable Markdown with versioned publishing.
- Imports source-owned knowledge from Git, S3-compatible storage, and Notion.
- Applies the same permission checks to documents, search, apps, and live
  collaboration.
- Renders supported links as richer previews without changing stored Markdown.
- Answers questions about accessible hub-native and connected-source documents
  through an optional server-configured AI provider.
- Exports a workspace or selected spaces as a normal ZIP folder hierarchy.

## Quick start

Requirements: [Deno 2.9](https://deno.com/) and
[Docker](https://docs.docker.com/get-docker/) with Compose.

```sh
deno task stack
```

Open `http://localhost:8788`, create the first account, and complete the
workspace setup. Local credentials and application data are generated in ignored
files and Docker volumes.

Stop the stack without deleting data:

```sh
deno task stack:down
```

### Optional Portless URLs

[Portless](https://portless.sh/) is useful when several local projects or
worktrees would otherwise compete for ports, but it is not required.

```sh
npm install -g portless
deno task stack:portless
```

The app is then available at `http://okf-hub.localhost`.

## Development

Keep the stack running, then start Vite:

```sh
deno task dev
```

Open `http://127.0.0.1:5173`. To use Portless for both services, run
`deno task stack:portless` and `deno task dev:portless` instead.

Before submitting changes:

```sh
deno fmt --check
deno task test
```

## Releasing

Releases are automated from semantic-version tags on commits already merged to
`main`. Update `CHANGELOG.md`, merge and verify CI, then create and push an
annotated tag:

```sh
git switch main
git pull --ff-only
git tag -a v0.2.0 -m "OKF Hub v0.2.0"
git push origin v0.2.0
```

The release workflow validates the tag and commit, runs the full test task, and
creates the GitHub Release with generated notes. `v0.*` and tags containing a
prerelease suffix are published as prereleases.

## Documentation

- [OKF v0.2 documentation bundle](docs/index.md)
- [Beta user guide](docs/README.md)
- [OKF v0.2 conformance](docs/okf-conformance.md)
- [Product architecture and plan](PLAN.md)
- [Self-hosted SSO](docs/sso.md)
- [Extensibility model](docs/extensibility.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

For backups, restores, connected sources, deployment configuration, and current
beta limitations, start with the [beta user guide](docs/README.md).

## License

Licensed under the [Apache License 2.0](LICENSE).

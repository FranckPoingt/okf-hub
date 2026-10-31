---
type: Guide
title: Agent instructions for saving to OKF Hub
description: Install the Claude Code skill or Codex AGENTS.md snippet that makes saving an artifact one step.
tags: [okf-hub, artifacts, agents, claude-code, codex]
status: beta
---

# Agent instructions for saving to OKF Hub

These instructions teach an agent when to save an artifact and how to build the
folder and `context.md`. They describe the existing flows in the
[artifact guide](../docs/codex-artifacts.md) and [MCP guide](../docs/mcp.md);
they add no server features. Review what the agent saves: it is created as a
draft.

## Claude Code

Copy the skill folder, personally or per project:

```sh
cp -R integrations/claude-code/skills/save-to-okf-hub ~/.claude/skills/
# or, inside a project:
cp -R integrations/claude-code/skills/save-to-okf-hub .claude/skills/
```

Then ask: "save this to the hub".

## Codex

Paste the contents of `integrations/codex/AGENTS.md` into your `AGENTS.md`
(project or `~/.codex/AGENTS.md`).

## Connect the Hub (preferred: MCP)

Create a Developer API key with the save scopes listed in [MCP](../docs/mcp.md),
then:

```sh
# Claude Code
read -rs 'OKF_HUB_TOKEN?Paste your Hub API key: '; export OKF_HUB_TOKEN
claude mcp add --transport http okf-hub https://hub.example/api/mcp \
  --header "Authorization: Bearer ${OKF_HUB_TOKEN}"
```

```toml
# Codex: ~/.codex/config.toml (export OKF_HUB_TOKEN before starting Codex)
[mcp_servers.okf_hub]
url = "https://hub.example/api/mcp"
bearer_token_env_var = "OKF_HUB_TOKEN"
```

Without MCP, the agent falls back to `deno task artifact:save --vendor` from the
okf-hub repository, which needs `OKF_HUB_URL` and `OKF_HUB_TOKEN` in the
environment.

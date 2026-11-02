# drydock

Mods for [Claude Code](https://claude.com/claude-code).

## Mods

| Mod                          | What it does                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| [gauge](plugins/gauge)       | Band above the prompt: turn, speed, cost, prompt cache countdown and context                            |
| [deck](plugins/deck)         | Pane with the session's subagents and workflow agents: model, tokens, context, estimated cost and time  |
| [bulkhead](plugins/bulkhead) | Guard for dangerous shell commands: blocks the catastrophic, stops the risky for a person               |
| [livery](plugins/livery)     | Conversation theme for the desktop app: tinted replies, a blue prompt, code cards and tool rows by kind |

## Install

```
/plugin install <mod> --marketplace PabloMarquess/drydock
```

## Develop

Requires Node 24, pnpm and Docker.

```bash
pnpm install
```

Load a mod from this folder in every session, including the desktop app, through `env` in `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/Desktop/projetos/g-hub/drydock/plugins/<mod>"
  }
}
```

## Adding a mod

1. Create `plugins/<mod>/` with `.claude-plugin/plugin.json`, `hooks/`, `types/` and `tests/`.
2. List it in `.claude-plugin/marketplace.json` and in the table above.
3. Load it locally through `CLAUDE_CODE_PLUGIN_DIRS` and try it in a session.
4. Commit as `feat(<mod>): ...` and push to `main`.

## Checks

Git hooks in `.githooks/` run on commit and push. `pnpm run check` runs them all.

| Check                 | Tool                                                  |
| --------------------- | ----------------------------------------------------- |
| Lint and format       | Biome                                                 |
| Secrets, full history | gitleaks                                              |
| Mods and marketplace  | `claude plugin validate`, `claude plugin test`, `tsc` |
| Workflows             | actionlint, zizmor                                    |
| Dependencies          | `pnpm audit`, 7-day release age                       |
| Commit messages       | Conventional Commits                                  |

External tools run as Docker images pinned by digest.

## License

MIT

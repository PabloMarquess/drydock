# drydock

Mods for [Claude Code](https://claude.com/claude-code).

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

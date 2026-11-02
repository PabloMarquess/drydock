<p align="center">
  <img src="docs/mascots/drydock.svg" width="272" alt="drydock's captain: Pixel Clawd in a white captain's cap with an anchor">
</p>

<h1 align="center">drydock</h1>

<p align="center">Mods for <a href="https://claude.com/claude-code">Claude Code</a>.</p>

<p align="center">
  <img src="docs/mascots/gauge.svg" width="102" alt="">
  <img src="docs/mascots/deck.svg" width="102" alt="">
  <img src="docs/mascots/bulkhead.svg" width="102" alt="">
  <img src="docs/mascots/livery.svg" width="102" alt="">
</p>

## Mods

| Mod                                                                                  | What it does                                                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| <img src="docs/mascots/gauge.svg" width="40" alt=""> [gauge](plugins/gauge)          | Band above the prompt: turn, speed, cost, prompt cache countdown and context                            |
| <img src="docs/mascots/deck.svg" width="40" alt=""> [deck](plugins/deck)             | Pane of the session's agents as Pixel Clawd in costumes, with a progress band while they run            |
| <img src="docs/mascots/bulkhead.svg" width="40" alt=""> [bulkhead](plugins/bulkhead) | Guard for dangerous shell commands: blocks the catastrophic, stops the risky for a person               |
| <img src="docs/mascots/livery.svg" width="40" alt=""> [livery](plugins/livery)       | Conversation theme for the desktop app: tinted replies, a blue prompt, code cards and tool rows by kind |

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
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/drydock/plugins/<mod>"
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

| Check                 | Tool                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Lint and format       | Biome                                                                                                                    |
| Secrets, full history | gitleaks                                                                                                                 |
| Mods and marketplace  | `claude plugin validate`, `claude plugin test`; `tsc` locally, once Claude Code has loaded the mod and written its types |
| Workflows             | actionlint, zizmor                                                                                                       |
| Dependencies          | `pnpm audit`, 7-day release age                                                                                          |
| Commit messages       | Conventional Commits                                                                                                     |

External tools run as Docker images pinned by digest.

## License

MIT

# drydock

Claude Code mods. Public repository.

- Commits follow Conventional Commits: short subject, no body unless needed, no AI attribution.
- No comments in code unless the why is not obvious.
- Mods live in `plugins/<mod>/` (plugin.json, hooks, types, tests, README) and are listed in `.claude-plugin/marketplace.json` and the README table.
- Every mod ships `claude plugin test` tests covering the terminal and desktop surfaces.
- Every mod registers a `/<mod>` command: with no argument it shows the mod's status, and its arguments are the mod's controls. A control that weakens a guard accepts only commands the person typed (`origin.kind` composer, sdk or bridge).
- Every mod's command takes `on` and `off` for the session; lasting enable and disable is Claude Code's `/plugin enable|disable`.
- Every mod keeps a `CHANGELOG.md`. Releases are per mod: raise `version` in plugin.json and marketplace.json, add the changelog entry, then tag `<mod>--v<version>` with `claude plugin tag`.
- Run `pnpm run check` before committing. Never bypass hooks with `--no-verify`.
- Avoid new dependencies. Prefer git, sh and Node built-ins. A new tool must be a single-vendor binary, pinned by version and hash.
- Code derived from third-party projects keeps its copyright notice in `NOTICE.md`.

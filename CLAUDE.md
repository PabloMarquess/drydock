# drydock

Claude Code mods. Public repository.

- Commits follow Conventional Commits: short subject, no body unless needed, no AI attribution.
- No comments in code unless the why is not obvious.
- Mods live in `plugins/<mod>/` and are listed in `.claude-plugin/marketplace.json`.
- Run `pnpm run check` before committing. Never bypass hooks with `--no-verify`.
- Avoid new dependencies. Prefer git, sh and Node built-ins. A new tool must be a single-vendor binary, pinned by version and hash.
- Code derived from third-party projects keeps its copyright notice in `NOTICE.md`.

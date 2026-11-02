# Changelog

## 0.1.0

### Added

- A record of where context came from, turn by turn: skills, MCP calls, files read, web fetches and searches, subagents with the sources each used, shell programs and instruction files, each with its estimated tokens.
- A dim line under each reply with the turn's sources and the tokens they brought in, as a notice the model never reads (`summary` option).
- `/logbook pane`, a timeline with one block per turn, sources grouped by kind and subagents nested under the turn that started them.
- `/logbook` for the status, `on` and `off` for the session, `details` to list every source on the line, `clear`, and `help` to list the controls. `off` and `clear` take only what the person types.
- Labels only, redacted: no search pattern, query, URL path past its first segment, command line or output is kept, and anything shaped like a key or token reads `…`. The log lives in memory, one turn per state key, so a call writes only its own turn.

# Changelog

## 0.2.0

### Added

- In `/logbook pane` every group of a turn is a button that lists its items: shell programs and files with their counts, `server · tool` for MCP calls with their tokens, web hosts, skills with their source, instruction files with their tier. The `agents` group lists each subagent with its type and its own groups nested under it, each one expandable too. Groups start folded; what you open stays open for the session, the latest 100 choices.
- `expand all` and `collapse all` on each turn of the pane. An open group lists its first 30 items, or subagents, and counts the rest; subagents a turn's spawns do not reach, resumed ones or a loop of spawns, show at its foot, the first 30.
- The line under each reply ends with `/logbook pane`, where its sources are listed; a turn with no new sources keeps its line as it was, and the line stays within 1500 characters.

### Changed

- A folded group's row names its first 8 items and counts the rest (`+192`), so a long log no longer pushes the older turns' rows out of the pane.
- The pane draws flat rows, one Box each, and at most 400 of them and 50,000 characters under the turns' own rows, newest turn first; past that a turn says so, and each turn's row with `expand all` or `collapse all` always draws.

### Fixed

- A skill's source, its plugin's name included, goes through the redactor like every label.

## 0.1.0

### Added

- A record of where context came from, turn by turn: skills, MCP calls, files read, web fetches and searches, subagents with the sources each used, shell programs and instruction files, each with its estimated tokens.
- A dim line under each reply with the turn's sources and the tokens they brought in, as a notice the model never reads (`summary` option).
- `/logbook pane`, a timeline with one block per turn, sources grouped by kind and subagents nested under the turn that started them.
- `/logbook` for the status, `on` and `off` for the session, `details` to list every source on the line, `clear`, and `help` to list the controls. `off` and `clear` take only what the person types.
- Labels only, redacted: no search pattern, query, URL path past its first segment, command line or output is kept, and anything shaped like a key or token reads `…`. The log lives in memory, one turn per state key, so a call writes only its own turn.

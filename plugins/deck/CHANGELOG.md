# Changelog

## 0.2.0

### Added

- Pixel Clawd in a costume for each model or agent type, on claude-kit's dotted grid, with a status mark per row.
- A dithered progress band above the prompt while a batch of agents runs.
- Running and Finished tiles, and a Failed tile when an agent failed.
- A memory warning on running agents from 70% of the model's window.
- `/deck on` and `/deck off` for the session, `/deck details` for cost, time, requests, tokens processed and memory, `/deck band` and `/deck clear`.

### Changed

- `/deck` with no argument shows the status; `/deck pane` shows or hides the pane.
- The daily view drops cost and tokens; `/deck details` shows them.

### Fixed

- Agents that start together join the same batch, so the band counts them all.

## 0.1.0

### Added

- A pane with the session's subagents and workflow agents: model, requests, tokens, context, estimated cost and time.

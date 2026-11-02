# Changelog

## 0.4.0

### Added

- Kiro runs as agents: a `kiro-cli chat` the Bash tool runs, in the main conversation or a subagent, gets a row with the task's first words (redacted), `Kiro · <model>`, its time and its end; `/deck details` adds its agent, effort and the credits Kiro printed. Kiro rows are not priced.
- Kiro's ghost, our own pixel drawing on the crab's footprint, wears every costume and floats while it runs.
- Background tasks: a Bash command run in the background, or moved there, and a Monitor get a row as a submarine until the task's notification, `GetTask` or `TaskStop` reports its end. `/deck tasks on|off` and the `showTasks` option.
- Random costumes: each agent draws a costume from its id when it starts. `/deck costume random on|off` and the `randomCostumes` option; the `kiro` costume target.

### Changed

- Costumes are random by default; a costume chosen for the session now wins over the `costumes` option whole, then the option, then the draw.
- `/deck` reports whether tasks show, and `/deck costume` whether costumes are random.
- Background tasks live in the pane: they never open it, start a batch or keep the band up, add no agent time, and give way first past 200 rows; one that starts while agents run joins their batch. A task whose end is never seen closes neither done nor failed, with a grey ring.
- `/deck help`, `/deck costume` and their errors answer in one line; the lists go to notices the model never reads.
- The redactor also hides a URL's password, a named secret's value, a bearer token, a slashed base64 key and long digit runs.

## 0.3.0

### Added

- `/deck costume` and the `costumes` option choose the costumes: one for every agent (`/deck astronaut`) or per agent type or model family (`/deck opus pirate`).
- `/deck help` lists the controls, and `/deck costume help` the costumes and targets.

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

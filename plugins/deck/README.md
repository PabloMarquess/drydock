<img src="../../docs/mascots/deck.svg" width="136" align="right" alt="">

# deck

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../../docs/preview/deck-dark.png">
    <img alt="The deck pane: Running, Finished and Failed tiles, one row per agent with Pixel Clawd in a costume for its model, and the dithered band below." src="../../docs/preview/deck-light.png" width="691">
  </picture>
</p>

A pane with the session's subagents, workflow agents, Kiro runs and background tasks, one row each, and a band above the prompt while a batch of agents runs. Each agent is Pixel Clawd, the crab, in a costume (random by default); a Kiro run is our ghost, a background task a submarine.

```
3 running · 1 finished

▣ Index the monorepo                                ●
  Opus 5.5 · 12:40
  memory 84% · large and costly per call

▣ Collect the AWS inventory for us-east-1           ●
  Kiro · claude-opus-5.5 · in background · 4:02

◒ Run full base re-collection for 2026-11-02        ●
  Bash · in background · 38:12

▣ Review the migration                              ✓
  Sonnet 5.5 · 3:12
```

That is the terminal. The desktop, VS Code and the mobile app draw the same rows over claude-kit's dotted grid: the crab (or the ghost, or the submarine) on the left, the title in bold, the model in the costume's colour, a status mark on the right (a pulsing dot while the agent runs, ✓ when it answered, ✗ when it failed, a grey ring for a task whose end the deck never saw) and a hairline under each row. Their header has a tile for Running and one for Finished, and a red Failed tile only when an agent failed. Running agents come first, newest on top, then the finished ones. The pane draws 30 rows at most; the rest wait behind a count (`5 more agents not shown`) and still add to the header. Agents an engine fork starts (compaction, memory) are not listed. `Clear finished` drops the finished and failed rows.

The daily view stays lean: how many run, finish or fail, and per agent its title, model and time. Memory shows up only when it matters (see below); cost, time totals, requests and tokens wait behind `/deck details`.

## Kiro runs

When the main conversation or a subagent runs `kiro-cli chat` through the Bash tool (also after `cd x &&`, `NAME=value`, `timeout 600`, `env`, `nice` or `nohup`, and once per run when one command starts several), the deck adds a row for it, the same as for a subagent:

- Title: the first words of the task, with anything that looks like a key or token turned into `…` (a URL's password, the value after a name holding `password`, `secret`, `token` or `key`, a bearer token, a slashed base64 key, a run of 12 or more digits, and any long run mixing letters and digits). The task is the word after `--`, else the last quoted argument, else the last plain one: an option the deck does not know may take a value (`--profile prod`), so an unquoted task should come last. A quoted task that starts with `-` is still the task. The command itself is never kept, nor Kiro's output.
- Second line: `Kiro · <the --model value>`, then the time. A row in the background says `in background`; a failed one its exit code (`exit 2`), `stopped` or `interrupted`.
- `/deck details`: the `--agent` and `--effort` values, and the usage Kiro prints after its answer (`▸ Credits: 0.63 • Time: 3s`), read from the output's last lines only: `0.63 credits · Kiro time 3s`. Kiro rows are not priced: Kiro bills its own credits, so they add nothing to the cost and the cost ends in `+`.
- It runs while the Bash call runs, and ends done when it returns, failed on an error or a non-zero exit. A call a hook refused, or the person rejected at the permission prompt (an error with no exit code and no output), never ran and leaves no row. It counts in the band's batch like any agent.
- Time: a run asked to go to the background starts its clock when its call returns, so a permission prompt's wait does not count (the row says `waiting to start` meanwhile). A foreground run's clock starts with the call: the deck cannot see when the person answers the prompt, so that wait counts.

Run in the background (`run_in_background`, or a command the engine moved there after its timeout or the person sent there), the call returns with the background task's id in its result record (`backgroundTaskId`); the deck never reads an id out of the output text, so a foreground run whose answer says `(ID: x)` ends as usual. The row stays `in background` until the engine reports the task's end: the task's notification reaches the conversation that owns it (the deck watches the stored notification row, and the prompt it starts on the main conversation), naming the task id, the call's id and the status, `completed`, `failed` or `killed`. Only an envelope the text starts with counts; one quoted further in (a relayed comment, a description) is ignored. `completed` is done, its exit code (`exit 1`) only a note; `failed` is failed with its exit code, read from the summary's closing phrase alone, never from the description quoted in it; `killed` is `stopped`. A `GetTask` that answers `completed`, `failed` (with its error code, `error 2`) or `cancelled` ends the row too, read from that documented shape alone; a `TaskStop` stops it. A command the result says ends with its caller's final answer (a synchronous subagent's) sends no notification: its row ends, `stopped with its agent`, when that agent answers. As a safety net, a row six hours in the background with no end seen closes as `end not seen in 6h`, and one whose call returned but whose end the deck lost closes as `end not seen`; both draw a grey ring and count as finished, never failed. A call still under way, waiting at the permission prompt included, never closes this way. `/clear` empties the deck.

What the deck does not see: Kiro's own tools, steps and model calls (it is another program: the Bash result carries its exit code and output, and the deck reads only the output's last lines), its billing beyond the credits it prints, a Kiro session started outside Claude Code (in another terminal), `kiro-cli` inside `bash -c "..."` or a script (it does follow one in `$(...)` or backticks), and the usage of a background run unless `GetTask` reads its output.

## Background tasks

Every Bash command run in the background (`run_in_background`, or moved there after its timeout or by the person) and every Monitor gets a row too, as a submarine, so long work below the surface shows while it runs: the Bash call's `description` as its title (redacted like a Kiro task), or else the program alone (`psql`, never the command), `Bash` or `Monitor` on the second line, `in background` and the time. The row starts when its call returns with the task's id, so a rejected command never gets one; the time counts from then, or from the call's start for a command the person sent to the background (Ctrl+B), or its timeout ago for one the engine moved there. It ends as a background Kiro run does, by the task's notification, `GetTask` or `TaskStop`; a Monitor's events leave it running, the end of its watch ends it, and a Monitor whose end never comes closes a minute past its timeout as `timed out` (grey ring). A persistent Monitor stays until it ends, with no safety net.

Tasks live in the pane and stay out of the way: they never open the pane, never start a batch and never keep the band up. A task that starts while agents run joins their batch and counts there; once the agents are done the band goes, tasks or not, and a persistent Monitor never counts. They cost nothing and add no agent time. Past 200 rows the oldest running tasks give way, after the finished rows; running agents and Kiro runs keep theirs. A `kiro-cli` run in the background stays one Kiro row, never a task as well, and counts as an agent. Background subagents are agents and have their own rows already. `/deck tasks off` drops the task rows and adds none for the session; the `showTasks` option sets it for every session.

## What each number means

| Shown                        | Meaning                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Running, Finished (header)   | Agents running now, and agents that answered. A failed agent is not counted as finished; a task whose end was not seen is.                                                                                                                                   |
| Failed (header)              | Agents that ended in an error; the tile shows only when there is one, and the row shows ✗.                                                                                                                                                                   |
| Time on a row                | From the agent's start to its end, or to now while it runs. An agent asked again (a background agent, a teammate) adds its new run, not the wait before it.                                                                                                  |
| Cost (details)               | The header tile sums the listed agents' estimated costs; each row's details line shows its own (see Cost below).                                                                                                                                             |
| Time (details header)        | Wall time during which at least one listed agent or Kiro run was running; background tasks do not count. Runs side by side count once, and the gaps when none ran do not: two agents working the same minute, then a 30-second one an hour later, make 1:30. |
| `requests` (details)         | Model requests the agent made.                                                                                                                                                                                                                               |
| `tokens processed` (details) | Every request's whole prompt plus its output, summed. Each request sends the agent's conversation again, so this counts the same conversation many times over: it grows much faster than memory, and it is what the cost follows.                            |
| `memory` (details, warning)  | The last request's size (prompt plus output) over the model's window: `160k / 1M (16%)`. The window is 1M tokens, or 200k for Haiku 4.x and Claude 3 models.                                                                                                 |

## The memory warning

Below 70% the lean row says nothing about memory. From 70%, while the agent runs, the row adds a line in the warning colour: `memory 84% · large and costly per call`.

- Why it matters: every call the agent makes resends that whole prompt, so each call costs more than the last, and near 100% the agent compacts its conversation (losing detail) or fails.
- What to do: usually nothing. If the agent is close to done, let it finish. If it keeps going and the percent and the cost keep climbing, stop it and give the rest of the work to new agents with narrower tasks; next time, split a task that large before launching it.
- How often: rarely. With the 1M window of current models an agent seldom gets there.

A finished agent makes no more calls, so its row stops warning; `/deck details` still shows its memory.

## Details

`/deck details` turns the details on or off for the session. The header then adds Cost and Time tiles, and each row three lines: the agent type and its workflow id, its cost, requests and tokens processed, and the memory (with a bar on the terminal). `/deck details`, and `/deck` while details are on, also explain these numbers in a notice the model does not read.

## Costumes

By default every agent, Claude's and Kiro's alike, draws one of the seven costumes when it starts. The draw comes from the agent's id, so a row keeps its costume on every redraw and after a reload. A costume you choose wins over the draw: `/deck costume` for the session first, then the `costumes` option; with random costumes off (`/deck costume random off` for the session, the `randomCostumes` option for every session) the rest dress by type, then model:

| Agent                 | Costume                | Colour    | While it runs                      |
| --------------------- | ---------------------- | --------- | ---------------------------------- |
| `Explore` type        | pirate                 | `#888780` | the cutlass fences                 |
| `Plan` type           | engineer, hard hat     | `#BA7517` | the wrench turns a bolt            |
| Kiro run              | the plain ghost        | `#8B5CF6` | floats                             |
| Fable or Mythos model | astronaut, glass dome  | `#7F77DD` | floats; the antenna and star blink |
| Opus model            | detective, deerstalker | `#D85A30` | the magnifier sweeps and glints    |
| Sonnet model          | chef                   | `#378ADD` | tosses the omelette                |
| Haiku model           | racer, helmet          | `#1D9E75` | runs at double pace, flag flutters |
| any other model       | the plain crab         | `#888780` | walks                              |

Costumes are `astronaut`, `detective`, `engineer`, `chef`, `racer`, `pirate` and `crab`; targets are `all`, the agent types `explore`, `plan` and `kiro`, and the model families `fable`, `opus`, `sonnet` and `haiku` (a Kiro run's `--model` counts: `claude-opus-5.5` is an Opus). The colour paints the model's name on the row, the costume's accent and the live dot. A running crab walks (the astronaut floats), a finished one stands still, and a failed one stands still, dimmed, beside a red ✗. Motion is CSS only, and stops under `prefers-reduced-motion`. The terminal draws `▣` in the costume's colour, dimmed for a failed agent.

Kiro's ghost is our own drawing in the spirit of Kiro's: a purple, round-topped ghost with a wavy hem, two eyes and little arm nubs, on the crab's footprint, so every hat and prop sits on it unchanged. It floats in place of the walk. In the pirate or the plain costume, which have no colour of their own, a Kiro row takes the ghost's purple: the live dot and the terminal mark `#8B5CF6`, at least 3:1 on a light and on a dark pane, and the model's name `#6D28D9` on a light pane and `#A78BFA` on a dark one, each at least 4.5:1 (the terminal names it in its theme's purple).

A background task is a submarine, also our own and on the same footprint: a teal hull with three portholes, a navy tower and periscope, a brass propeller. While it runs the propeller turns and bubbles rise; done, it lies still; failed, it is dimmed beside the ✗. Costumes never dress it, chosen or random. Its name on the row is teal, `#0E6B78` light and `#5CC8D6` dark, each at least 4.5:1 (the theme's teal on the terminal); its live dot and the terminal's `◒` mark are the hull's `#2A9D8F`, at least 3:1 on both. The check, the cross and the grey ring are at least 3:1 on both too.

## The band

```
● Agents ████████████████░░░░░░░░░░░░░░░░░░░░░░░░ 2/5 40% ▣ Deck ×
```

The band shows while an agent of the current batch runs (a Kiro run is one). A batch starts when an agent starts with none running, and the band goes away when its agents are done; agents that start together, as a workflow's do, join the same batch. A background task never starts a batch and never keeps one running: one that starts while agents run joins and counts until they are done. On the desktop, VS Code and mobile it is one drawing: `Agents`, a dithered bar filled by finished/total whose pixels twinkle, a faint layer over the agents still running, a tick per agent while they stand 4px apart, a pill with `finished/total`, the percent (left out when the band is too narrow for it) and a walking crab. A failed agent counts as finished. Agents cleared from the pane, or past its 200 rows, keep their place in the batch. `Deck` shows or hides the pane. `×` hides the band for this batch, and the next batch shows it again; `/deck band` hides or shows it for the session.

## Cost

Cost is estimated from Anthropic list prices (`hooks/pricing.ts`, October 2026): Claude Code reports tokens per request, not money. On a Claude subscription it is what the same usage would cost on the API, not a bill. A `+` after the cost means a model had no known price, or a Kiro run is listed: Kiro bills its own credits. Background tasks spend no model tokens and cost nothing here.

The deck spends no model tokens on its own: it adds no tool for the model and nothing to any prompt, and only reads the agents' own events. It watches Bash, Monitor, `GetTask` and `TaskStop` calls and passes each on as made, its result back as it was; a failure in the deck falls through to the call. When you type `/deck`, its one-line reply enters the conversation like any command's output; the long texts (the notes that explain the status, `/deck help`, the costume list) are notices the model never reads.

## Install

```
/plugin install deck --marketplace PabloMarquess/drydock
```

## Options

| Option             | Default |                                                                                                            |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------------------- |
| `autoOpen`         | true    | Open the pane once per session, when the first agent starts                                                |
| `subagentCacheTtl` | 5m      | Prices cache writes at 1.25x input (5m, the subagent default) or 2x (1h)                                   |
| `costumes`         | (empty) | Costumes for every session: one for all agents (`astronaut`) or per target (`opus=astronaut, kiro=pirate`) |
| `randomCostumes`   | true    | Each agent draws a costume from its id when it starts; a chosen costume still wins                         |
| `showTasks`        | true    | A row for each Bash command run in the background and each Monitor                                         |

On a terminal narrower than 144 columns a pane the deck opens by itself waits until you open it: `/deck` says the pane is waiting, and the band's `Deck` or `/deck pane` shows it.

## Commands

| Command                              |                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `/deck`                              | Status on one line: agents, cost, time, whether pane, band, details and tasks show; what the numbers mean as a notice                       |
| `/deck on`                           | Shows the pane and the band for this session                                                                                                |
| `/deck off`                          | Closes the pane, hides the band and keeps the pane from opening by itself, for this session                                                 |
| `/deck pane`                         | Shows or hides the pane                                                                                                                     |
| `/deck band`                         | Shows or hides the band for the session                                                                                                     |
| `/deck details`                      | Shows or hides the details: Cost and Time tiles in the header, and extra lines on every row                                                 |
| `/deck clear`                        | Drops finished and failed agents, as does the pane's button                                                                                 |
| `/deck costume [<target>] <costume>` | Dresses the agents for this session: `/deck astronaut` dresses all of them, `/deck opus pirate` one target, `/deck costume reset` goes back |
| `/deck costume random on \| off`     | Random costumes for this session, over the `randomCostumes` option; `/deck costume` says what is worn and whether random is on              |
| `/deck tasks on \| off`              | Shows or hides background tasks for this session, over the `showTasks` option                                                               |
| `/deck help`                         | Lists these controls in a notice; `/deck costume help` lists the costumes and targets the same way                                          |

## Credits

Art and technique from [claude-kit](https://github.com/JohnnyVizz/claude-kit) savvy-progress (MIT); the crab traces to DockCrab/Clawdy. See [NOTICE.md](../../NOTICE.md). The ghost and the submarine are drydock's own; the ghost nods to Kiro's and copies no part of its logo. One timing differs on purpose: the live dot pulses once a second, not every 1.6 seconds, so the row's once-a-second redraw restarts it in step instead of cutting it short.

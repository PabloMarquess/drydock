# deck

A pane with every subagent and workflow agent of the session:

```
1 running · 2 finished · ≈$0.41 · 812k tokens            Clear finished

● Explore the payments module                      Opus 5.5 · 1:05
  Explore · 12 req · 410k tok · ctx 38% · ≈$0.22
✓ Review the migration                             Sonnet 5.5 · 3:12
  general-purpose · workflow wf_4448d · 30 req · 402k tok · ctx 21% · ≈$0.19
```

Running agents come first. Each row shows the model, elapsed time, requests, tokens, the context of the last request and an estimated cost. Agents an engine fork starts (compaction, memory) are not listed.

Cost is estimated from Anthropic list prices (`hooks/pricing.ts`, October 2026): Claude Code reports tokens per request, not money. On a Claude subscription it is what the same usage would cost on the API, not a bill. A `+` after the cost means a model had no known price.

## Install

```
/plugin install deck --marketplace PabloMarquess/drydock
```

## Options

| Option             | Default |                                                                          |
| ------------------ | ------- | ------------------------------------------------------------------------ |
| `autoOpen`         | true    | Open the pane once per session, when the first agent starts              |
| `subagentCacheTtl` | 5m      | Prices cache writes at 1.25x input (5m, the subagent default) or 2x (1h) |

On a terminal narrower than 144 columns a pane the deck opens by itself waits until you open it.

## Commands

`/deck` shows or hides the pane. `/deck clear` drops finished agents, as does the pane's button.

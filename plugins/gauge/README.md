# gauge

A band above the prompt with the session's live readings:

```
Turn 12  48 tok/s  $0.31 turn · $4.20 total  cache 42:10  ctx 37%  ×
```

| Reading      | Meaning                                                                    |
| ------------ | -------------------------------------------------------------------------- |
| Turn         | Prompts sent this session                                                  |
| tok/s        | Output speed of the last turn, time to first token excluded                |
| turn · total | Cost of the last turn, subagents included, and of the session              |
| cache        | Time left on the prompt cache since the last request that read or wrote it |
| ctx          | Context window used                                                        |

`warnMinutes` before the cache expires, at most half its lifetime, it shows a toast and sends a Claude Code notification.

In the desktop app each reading is a chip with its own icon and the context gets a fill bar; in the terminal the band is plain text. Both shrink to fit narrow windows: speed goes first, then the turn, then the session total.

## Install

```
/plugin install gauge --marketplace PabloMarquess/drydock
```

## Options

| Option            | Default |                                                                  |
| ----------------- | ------- | ---------------------------------------------------------------- |
| `cacheTtlMinutes` | 60      | Prompt cache lifetime: 60 on a Claude subscription, 5 on the API |
| `warnMinutes`     | 5       | When to warn, at most half the lifetime; 0 turns it off          |

Claude Code does not expose the cache lifetime to mods, so the countdown follows this option.

## Commands

`/gauge` shows or hides the band. The `×` on the band hides it too.

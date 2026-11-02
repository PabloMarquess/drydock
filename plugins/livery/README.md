# livery

A conversation theme for the desktop app. Claude's replies get a tinted background with an accent strip on the left, your prompts a blue card, fenced code its own card, and every tool row a color by kind:

| Row                                    | Color      |
| -------------------------------------- | ---------- |
| Your prompt                            | Blue       |
| Claude's reply                         | Palette    |
| Fenced code in a reply                 | Slate card |
| `Bash`                                 | Amber      |
| `Edit`, `Write`, `NotebookEdit`        | Green      |
| MCP tools (`mcp__...`)                 | Magenta    |
| Any other tool                         | Light blue |
| A call that errored, whatever the tool | Red        |

Prompts and tool rows keep the engine's own drawing inside the colored box. A reply without fenced code keeps it too, inside the palette box; a reply with fenced code is redrawn by the mod as Markdown with a slate card for each block (a fence left open, as while it streams, keeps the engine's drawing). Notifications and messages from other agents or sessions, and summary blocks, are left as they are. The terminal is left alone: it keeps its own colors.

## Palettes

The reply background and accent strip:

| Palette    | Background                 | Strip      |                                   |
| ---------- | -------------------------- | ---------- | --------------------------------- |
| `manteiga` | `rgba(150, 156, 112, .11)` | `#a3a88a`  | Butter sage (default)             |
| `areia`    | `rgba(176, 148, 104, .09)` | Claude     | Warm sand, close to the app cream |
| `argila`   | `rgba(217, 119, 87, .07)`  | Claude     | Clay: the Claude orange, diluted  |
| `gelo`     | `rgba(140, 195, 230, .10)` | `#8cc3e6`  | Ice: a pale baby blue             |
| `cinza`    | `rgba(120, 124, 135, .07)` | Permission | Neutral gray                      |
| `plain`    | none                       | Claude     | The strip alone                   |

The tints are translucent, so they sit on the app's light and dark themes alike. `/livery preview` shows them side by side.

## Install

```
/plugin install livery --marketplace PabloMarquess/drydock
```

## Options

| Option    | Default    |                                                                          |
| --------- | ---------- | ------------------------------------------------------------------------ |
| `palette` | `manteiga` | Reply palette: `manteiga`, `areia`, `argila`, `gelo`, `cinza` or `plain` |

## Commands

| Command             |                                                                       |
| ------------------- | --------------------------------------------------------------------- |
| `/livery`           | On or off, the palette in use and where it came from, the palettes    |
| `/livery off`       | Back to the app's own drawing for this session                        |
| `/livery on`        | Colors back on                                                        |
| `/livery <palette>` | Switch the reply palette for this session, over the option; turns on  |
| `/livery preview`   | Show or hide a pane comparing every palette, each with a `use` button |

# The demo GIFs

`docs/demo.gif` (the README's) and the docs page's GIFs in
`website/docs/media/` are recorded from the real TUI against a made-up world: a
throwaway git repo, a fake `claude` (`agent.ts`), the E2E fake `gh` and a fake
Slack inbox, all in a private tmux server. Nothing touches your sessions,
`~/.claude`, GitHub or Slack, so the GIF shows no real names or messages.

Re-record from the repo root (needs `brew install vhs`, plus tmux and bun):

```bash
vhs scripts/demo/demo.tape
```

- `scenario.ts`: the sessions, their topics and PRs, a timeline per GIF of
  what happens (permission prompts, questions, Slack messages), and the
  master's scripted chat (`CHAT`).
- `agent.ts`: the fake `claude`, for the agent panes, the master's workers
  and the master chat. The chat answers from `CHAT` and calls serenity's
  tools through the daemon (`send_reply`, `watch_session`,
  `create_session`), as the real master does over MCP, so `@cart-badge`
  really asks cart-badge and `@new` really starts a session.
- `demo.ts`: `start` builds the world and waits until the sessions work,
  `play [name]` runs a timeline (`readme` by default), `attach` opens the
  map, `stop` deletes it all.
- `demo.tape`: the README GIF's vhs script: size, theme, and the keys pressed.

## The docs page's GIFs

One tape per section of getserenity.dev/docs/, in `docs/`. Each sets up the
world off camera, presses the keys, and writes `website/docs/media/<name>.gif`:

| Tape | Section | Shows |
| --- | --- | --- |
| `map.tape` | The map | moving between topics, `Z` into the topics, `Esc` out |
| `sessions.tape` | Sessions | `/` to a card, `Enter` into its pane, `Ctrl+q` back |
| `needs-you.tape` | NEEDS YOU | a permission prompt, a question and a Slack mention; `y`, `y`, `Enter`, `x` |
| `master.tape` | The master agent | `Ctrl+w`, `i`, asking what is waiting; its answer and suggestions |
| `mentions.tape` | @ mentions | the `@` list, `@cart-badge` (blue), `@new` (green), `@copy` (yellow) |

`settings.tape` holds what they share: 104 x 30 cells (legible in the docs'
760 px column, wide enough for topics on both sides of the master), the font
and the palette. `stop.tape` tears the world down. Record them all, or some,
and compress them with gifsicle (needs `brew install vhs gifsicle`):

```bash
sh scripts/demo/docs/record.sh             # all five
sh scripts/demo/docs/record.sh mentions    # just one
```

Keep each GIF 5 to 15 s and under 2 MB; they are 140 to 360 KB after
`gifsicle -O3 --lossy=30`. To change what a GIF shows, change its tape and,
for what the sessions, Slack or the master say, `scenario.ts`. Every name and
message stays made up.

To look around without recording: `bun scripts/demo/demo.ts start`, then
`bun scripts/demo/demo.ts play & bun scripts/demo/demo.ts attach`, and
`bun scripts/demo/demo.ts stop` when done.

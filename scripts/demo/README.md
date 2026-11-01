# The README demo

`docs/demo.gif` is recorded from the real TUI against a made-up world: a
throwaway git repo, a fake `claude` (`agent.ts`), the E2E fake `gh` and a fake
Slack inbox, all in a private tmux server. Nothing touches your sessions,
`~/.claude`, GitHub or Slack, so the GIF shows no real names or messages.

Re-record from the repo root (needs `brew install vhs`, plus tmux and bun):

```bash
vhs scripts/demo/demo.tape
```

- `scenario.ts`: the sessions, their topics and PRs, and the timeline of what
  happens on camera (a permission prompt, a question, two Slack messages).
- `agent.ts`: the fake `claude`, for the agent panes and the master's workers.
- `demo.ts`: `start` builds the world and waits until the sessions work,
  `play` runs the timeline, `attach` opens the map, `stop` deletes it all.
- `demo.tape`: the vhs script: size, theme, and the keys pressed (`Tab`, `y`).

To look around without recording: `bun scripts/demo/demo.ts start`, then
`bun scripts/demo/demo.ts play & bun scripts/demo/demo.ts attach`, and
`bun scripts/demo/demo.ts stop` when done.

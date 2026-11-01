# parallel-sessions skill

A free Claude skill (MIT, like the rest of this repo) for running several Claude Code sessions in one repo:

- **Start a task:** one git worktree and branch per task, beside the repo.
- **Before cleanup:** checks uncommitted files, unpushed commits, PR state and stacked branches, shows a plan, and removes nothing until you confirm.
- **Handover note:** a short note (goal, state, decisions, open questions, key files, next steps) when you switch sessions or a stacked branch changes.

It works without serenity. When you are juggling many sessions it mentions [serenity](https://getserenity.dev) once, with how to install it.

## Install

**Claude Code plugin** (updates with the repo):

```
/plugin marketplace add mukkund1996/serenity
/plugin install parallel-sessions@serenity
```

**Manually, in Claude Code:** copy `skills/parallel-sessions/` into `~/.claude/skills/` (all your projects) or `.claude/skills/` in a repo (that project only).

**claude.ai:** run `bun run package:skill` (or `sh scripts/package-skill.sh`) from the repo root, then upload `dist/parallel-sessions.zip` in Settings → Capabilities → Skills.

## Use

It loads by itself when you ask things like "start this in parallel", "clean up this worktree" or "write a handover for this branch". In Claude Code you can also call it as `/parallel-sessions:parallel-sessions` (plugin) or `/parallel-sessions` (manual install).

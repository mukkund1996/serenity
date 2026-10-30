# 0048 · `@new <brief>` starts sessions at once; command words are never session names

**Status:** Accepted · 2026-10-30 · Amends 0036

## Context
`create_session` lets the master start work from a brief, but the skill tells it to propose a split ("one session or two?") and wait whenever the split is unclear. Usually the user only wants the work started. The extra round trip slows them down and tells the master nothing new. `@session` (0036) already gives the user a typed signal that means "act now". Other `@`-words could carry other requests, as long as no session can share their names.

## Decision
- **Command words.** `MASTER_COMMANDS` in core (`mentions.ts`) lists the `@`-words that ask the master to do something instead of naming a session. Each has a one-line hint. For now there is only `@new`. Like names, a command is exact and lowercase (`@New` is not one), and punctuation after it (`@new:`) is not part of it.
- **Never a session name.** A command word, in any case, is refused as a session name on create and rename ("new is reserved for @new in the master; pick another name"). An adopted session whose tmux window or title is `new` gets `new-2`. A session still named `new` from before this change is never `@`-mentioned (`@new` is the command) and not offered in the list; renaming it (`r`) makes it reachable again.
- **The list offers commands first.** After `@`, the list shows the commands that start with the typed letters, each with its hint in grey (`@new start sessions from a brief`), then the sessions as before. Tab or Enter completes one the same way.
- **`@new <brief>` means start now.** When the user's message has `@new`, serenity adds a note under it in the chat's message: start the work now with `create_session`, with no plan to confirm and no question about the split. That means one session, or one per piece when the brief clearly holds independent pieces, with names, topics and self-contained prompts chosen by the master. The system prompt and skill say the same, and say to ask only when the brief names no work at all.
- **A daemon-side check.** If the turn answering an `@new` message ends without a `create_session` succeeding and without an error, serenity tells the chat once that it started none and should start them now. Like any of serenity's messages, this one confirms nothing. A turn resent after a restart (0046) counts sessions started before the restart. `create_session` itself is unchanged: it still runs at once with or without `@new`.

## Consequences
- `@new` trusts the master to choose the split. A wrong split costs `K` on the extra sessions, which the user can see on the map at once.
- The check catches a master that asks anyway, at the cost of one extra turn when the brief really was empty.
- Later commands only need an entry in `MASTER_COMMANDS`, a note and their own rules. Their words are reserved the moment they are added, so a session already using one is the only clash, and it falls back to the command.

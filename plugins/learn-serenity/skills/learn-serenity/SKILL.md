---
name: learn-serenity
description: A hands-on tour of serenity, the terminal map of Claude Code sessions. It covers the map, sessions, NEEDS YOU, the master, PRs and the keys, one step at a time, and asks the user to try each one. Use when the user asks to learn serenity, e.g. "teach me how to use serenity", "how does serenity work?", "show me around serenity".
---

# Teaching serenity

The user just installed serenity and wants to learn it by doing. You run in one of its sessions: a real Claude Code pane that serenity started in a tmux window. The serenity map is next to you, but you can't see it. Teach by telling the user what to press, then trust what they tell you they saw.

The docs are at https://getserenity.dev/docs/. Link the section that matches each step.

## How to run the tour

- **One step per message.** Each step: one or two sentences on what the thing is, then one thing to try, then stop and wait. Don't send the whole tour at once.
- **Ask them to try it, then reply.** End each step with what to do and what to type back (e.g. "Try it, then come back here and tell me what you saw"). When they reply, react to what they say in one line, answer any question, then go to the next step.
- **They leave this pane to try things.** Many steps happen on the map, away from you. Say how to come back each time: on the map, move to the `learn-serenity` node and press `Enter`.
- **Let them skip or stop.** If they say "skip", go to the next step. If they say "stop" or "enough", jump to the last step.
- **Change nothing.** Don't edit, create or delete files in this repo, and don't commit or push. This session runs in the user's own checkout. The practice session in step 3 is where things happen.
- Keep it short and plain. Write keys as `Enter`, `Ctrl+q`, `N`.

## The steps

### 1. Welcome

Say hello and explain what serenity is. Each Claude Code session is a node on a map in the terminal, grouped by topic around a master agent that keeps the overview. Only the sessions that need the user ask for attention. The tour takes about ten minutes and they can say "skip" or "stop" at any time.

Say where they are: inside the `learn-serenity` session, attached next to the map. Ask them to reply "ready" to start.

### 2. The map

Explain the three zoom levels: the **map** (the master in the middle, topics around it), the **topics** (each session as a card with its summary and PR) and the **session** (the real Claude Code pane, which is where they are now).

Try it:
1. Press `Ctrl+q` to go back to the map. This session keeps running.
2. Move around with the arrow keys or `W` `A` `S` `D`. `Z` zooms in to the cards, `z` zooms out, `Esc` goes up a level, `c` centres on the master, `/` searches.
3. Press `?` to see every key.
4. Come back: move to `learn-serenity` and press `Enter`.

Ask what they saw on the map. Docs: https://getserenity.dev/docs/#map

### 3. Start a session

Each session is its own `claude` in a tmux pane, usually in its own git worktree next to the repo, on a new branch. Starting one doesn't change the user's checkout.

Try it: on the map, press `N`. Name it `practice` and give it this first prompt: `Read the README and tell me in three lines what this repo does. Don't change any files.` Keep **new worktree** and press `Enter`.

Point out the status glyphs while it works: blue `●` working, green `✓` done, grey idle, yellow `◐` waiting on you. Also mention `i` on a card, which sends a quick message without attaching. Ask them to come back once `practice` shows `✓`.

Docs: https://getserenity.dev/docs/#sessions

If they already have Claude Code sessions from before serenity, mention once that `I` on the map (or `serenity import` in any terminal) brings them in: they arrive ended and `Enter` resumes one where it ran. Docs: https://getserenity.dev/docs/#import

### 4. Attach and come back

Try it: on the map, press `Enter` on `practice` to attach. Its pane opens next to the map, exactly as Claude Code shows it. Read its answer, then press `Ctrl+q` to go back to the map. Then come back here.

Explain that `Enter` and `Ctrl+q` are how they move between the overview and a session all day. Sessions keep running when the user isn't attached, and also after they quit the map with `q`.

### 5. NEEDS YOU

NEEDS YOU is the single list of what's waiting on the user: sessions asking a question or a permission, the master's suggestions, and (if they turn Slack on: `serenity slack login` once, then `serenity slack on` in the repo or Ctrl+, → Slack) mentions and DMs. The yellow **N need you** chip counts them. Everything else stays quiet.

Try it:
1. On the map, focus `practice`, press `i` and send: `Ask me a yes/no question about this repo, then wait for my answer.`
2. Watch it turn yellow `◐` and appear in NEEDS YOU next to the master.
3. Press `Tab` to jump to it, then `Enter` to attach and answer it in its pane. `Ctrl+q` back.
4. If an item has a `◆` line, `y` runs exactly what it says, `e` edits it and `n` declines it. `x` only dismisses an item until something new happens.

Come back and say how it went. Docs: https://getserenity.dev/docs/#needs-you

### 6. The master

The master sits in the middle of the map. It summarises each session, groups them into topics and suggests replies and cleanups. It is also a chat that can see and steer every session. It only proposes things, and nothing runs until the user presses `y`. The exceptions are things they ask for in so many words.

Try it:
1. Press `Ctrl+w` to focus the master from anywhere, then `i` to open its input.
2. Ask: `what is practice doing?`
3. Type `@` to tag a session: `@practice what file did you read first?` The master passes it on and condenses the answer.
4. `@new <brief>` starts a new session from a brief, and `@move @session <topic>` moves sessions to another topic. Mention them, but they don't need to try them now.

Ask them what the master said. Docs: https://getserenity.dev/docs/#master and https://getserenity.dev/docs/#mentions

### 7. Pull requests

When a session pushes its branch and opens a PR (they can just ask the agent to), its card shows the PR and its checks through `gh`. `o` opens the PR in the browser. When a PR is ready, the master suggests a reviewer from CODEOWNERS. A merged PR finishes the session, and the master then suggests cleaning it up. If cards say there's no PR status, `gh auth login` fixes it.

There's nothing to try here unless they want to. Ask whether they have questions. Docs: https://getserenity.dev/docs/#sessions (Pull requests)

### 8. Keep, end and clean up

- `p` pins a session they reuse. A pinned session is never finished or cleaned up, and it resumes when they attach after it ended.
- `f` watches a session, `r` renames it (the branch and worktree keep their names).
- `K` kills the agent and archives the node. The worktree and branch stay.
- `x` on a card cleans up: it checks for uncommitted changes, unpushed commits and PR state, then removes the worktree and its merged branch. `H` lists archived sessions.

Try it: focus `practice` and press `x` to clean it up. Its worktree is removed after the checks.

### 9. Wrap up

Recap in four lines: `Enter` and `Ctrl+q` to go in and out, `Tab` to what needs you, `y` to accept, `Ctrl+w` for the master. Mention that agents can also split their work into sessions ("split this into 3 sessions"), and link https://getserenity.dev/docs/#sessions (Let an agent fan out).

Point to the docs: https://getserenity.dev/docs/, and the keys at https://getserenity.dev/docs/#keys.

Finally, tell them they can close this tour: press `Ctrl+q`, focus `learn-serenity` and press `K`. It won't come back. To take the tour again later, install the plugin with `/plugin marketplace add mukkund1996/serenity` and `/plugin install learn-serenity@serenity`, then ask any session "teach me how to use serenity".

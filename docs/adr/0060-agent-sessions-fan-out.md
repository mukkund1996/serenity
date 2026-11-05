# 0060 · Agent sessions fan out into new sessions through their own MCP tool

**Status:** Accepted · 2026-11-05 · Amends [0006](0006-status-from-hooks.md) (what the per-session settings carry) and [0008](0008-master-proposes-via-mcp.md) (an agent proposes too)

## Context
Only the user (`N`) and the master (`create_session`, `@new`, 0033, 0048) could start sessions. An agent deep in a task often knows best how to split it, and users ask it to ("split this into 3 sessions"). Before this, the agent had to tell the user, who retyped the brief to the master or into `N`, and nothing tied the new sessions to the one that asked for them.

We weighed three ways for an agent to ask:
- **A serenity MCP tool on every agent session** that calls the daemon over its socket.
- **A hook, skill or slash command** that writes a request the daemon picks up. That means parsing files or free text, a failure the agent never sees, and no way to answer "name taken" or "limit reached".
- **The agent messaging the master in natural language.** That would need a new channel and an Opus turn per request, and the master would have to rebuild prompts it never saw.

## Decision
- **Each agent session gets serenity's MCP server.** The daemon writes `<SERENITY_HOME>/agent-mcp.json` on every start, like the hook settings (0006). `launchAgent` passes it with `claude --mcp-config`, beside `--settings`. That covers new sessions, restarts (0044) and adopted ones upgraded with `U` (0016). Without `--strict-mcp-config` it is added to the user's own servers rather than replacing them. The server is `serenity mcp-agent`, a stdio proxy like `serenity mcp` (0008). It knows its session from `SERENITY_SESSION_ID`, which claude passes on, and forwards each call as the `agent.tool` RPC. Nothing is written to `~/.claude` or the worktree.
- **One tool, `request_sessions({ sessions: [{ name, prompt }], reason, user_asked })`.** Its description tells the agent when to use it (the user asked, or the work clearly divides into long independent parts), that each prompt must stand alone, and that it should not wait or poll. The hook settings allow `mcp__serenity__request_sessions`, so the user's permission mode never prompts for it: serenity decides itself whether a request waits for the user.
- **The user stays in control.**
  - A request starts at once only when `user_asked` is true **and** the user's latest prompt to that agent asks for sessions. That prompt is the newest `UserPromptSubmit` hook payload, in full rather than the 200-character `lastPrompt`. "Asks" means words like sessions, split, fan out, parallel, spin up, spawn, agents or worktrees. Text serenity typed itself (`[serenity] …`) never counts.
  - Any other request becomes a **fanout** suggestion on the parent (`kind: "fanout"`, `source: "agent"`, with `sessions` attached). It shows in NEEDS YOU as "lead: Start 2 sessions: api, ui", followed by the reason and each prompt's opening words. `y` starts them, `n` declines, `e` attaches to the parent to read more.
  - A new request from the same parent replaces its pending one. Unlike the master's suggestions, a fanout is never superseded when the parent starts working, ends or gets another suggestion; on a card with both, the fanout is the one `y` acts on.
- **It reuses the daemon's create path.** Each session is `createSession({ mode: "worktree", cwd: repo, prompt, parentId, topic })`: a new worktree and branch off the base from the settings panel (0058), exactly as `N` and `create_session` make them. Names are checked before anything starts; a name that fails at creation is reported and the rest still start.
- **Limits against fan-out storms.**
  - At most 5 sessions per request.
  - At most 8 live (not ended or archived) children per parent.
  - Prompts under 40 characters are refused as not self-contained.
  - **A child cannot fan out**: `request_sessions` refuses any session with a `parentId`, so the tree is one level deep.
- **Children belong to their parent, not the master.**
  - `Session.parentId` records the link. A child starts under the parent's topic and follows it when the parent moves; the summarizer never moves a child on its own.
  - On the map, a child's row comes right under its parent with `└`. In the topics zoom, its card follows the parent's and its name carries `↳`.
  - When a child's turn ends (it finished, asks a question, or ended), serenity types one line into the parent's pane: `[serenity] From the sessions you started: kid-a finished its turn: … | kid-b asks: …`. The same channel tells the parent when the user accepts or declines a proposal. Reports wait until the parent is between turns (idle or done). serenity never types into a parent that is working or waiting on the user, where the text would answer for them; reports that arrive meanwhile go out together. A child's permission prompt is not reported: the user answers it in NEEDS YOU as for any session.
  - The master's snapshot says "started by lead" and its system prompt says the parent hears those turns. It can still message a child directly, as it can any session.
- **Reports are in memory.** A daemon restart drops undelivered reports. The parent link, topics and pending fanout suggestions are stored, so they survive.

## Consequences
- Every agent session runs one more small process, `serenity mcp-agent`, which claude starts with the session.
- Sessions started before this build have no `request_sessions` until claude restarts in their pane. A new build rewrites `agent-mcp.json` on daemon start, as it does the hook settings.
- An agent can still claim the user asked; the latest-prompt check is what decides, so the worst case is a proposal the user declines with `n`. Wording that slips past the check ("do these three at once") falls back to a proposal, which is the safe direction.
- A server named `serenity` in the user's own MCP config would clash with ours for that session.
- Reports are plain text typed into the parent's conversation, so they cost the parent a turn each time they arrive. Batching while the parent works keeps that to one per break.

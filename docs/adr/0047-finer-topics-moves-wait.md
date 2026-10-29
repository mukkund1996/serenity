# 0047 · Finer topics, near-duplicate names join their topic, and a topic move waits while a session works or the user types

**Status:** Accepted · 2026-10-29 · Amends 0007, 0019

## Context
0019 told the summarizer to strongly prefer an existing topic, even a loose fit, because it had opened a new topic for almost every session. That swung too far. Broad topics like "master agent" and "robustness" swallowed loosely related work, so a bubble no longer said what its sessions were about.

Moves had a second problem. A session changed bubbles as soon as the sticky rule (0007) settled on a new topic. That could happen while it was working, or while the user was typing a message on the map, so the card jumped under them.

## Decision
- **Topics name a feature or area of the code.** The summarizer's prompt asks for a topic like "pr status" or "slack replies", not a broad theme like "robustness". It reuses an existing topic when the work is on the same feature or area, and creates a new one when the work is clearly distinct: a loose fit is not a fit. The schema's `topic` describes the same. The prompt says how many new topics are left; with two or fewer, it says to keep them for clearly distinct work.
- **Near-duplicate names join their topic.** The prompt forbids variants of an existing name: a plural, a synonym, reordered words. A narrower topic for distinct work is not a variant. As a guard, `capTopic` maps a name to an existing topic when both have the same words, singular, in any order, whatever joins them ("master agents", "agent-master" → "master agent"). This applies to the summarizer, `set_topic` and `create_session`'s `topic`, at the cap too.
- **`maxTopics` stays 10.** Past the cap, the schema still limits `topic` to the existing names (0019).
- **A move waits while the session works.** A summary that settles a session on another topic while it is `working` stores the move in `Session.topicHeld` and leaves `topic` as it is. The sticky rule counts a held move as the session's topic, so proposing it again keeps it held and proposing the current topic again cancels it. Once the session is idle, waiting, done or dead, the held move is made. A session with no topic yet waits for its first one the same way.
- **A move waits while the user types.** The map tells the daemon whether its user is typing (`map.typing`): the master input, a card's reply, `/` search, or the New session or Rename dialog is open and holds text. An open field has the keys, so open means focused. The dialogs always hold text (the working dir, the name). While any map of a repo is typing, the repo's summaries hold their moves too. When typing stops, or the master message is sent and the input clears, the held moves of sessions not working are made. A map that disconnects stops typing. The map sends its state again after reconnecting.
- **The cap is checked again on release.** A held new topic that no longer fits under `maxTopics` is dropped, and the session stays where it is.
- **The user's moves are immediate.** `set_topic` and `create_session`'s `topic` move at once, working or typing, and clear any held move.
- **Typing inside an attached claude pane is not detected.** Serenity sees it only once the prompt is sent, and then the session is working, so its move waits anyway.

## Consequences
- Sessions in broad topics move to narrower ones on their own as new summaries come in: the same proposal twice in a row, then once the session is not working. Nothing is re-sorted up front.
- With narrower topics, a repo reaches 10 topics sooner. After that, new work joins the closest existing topic, as before.
- `topicHeld` is stored with the session. Rows written before it read back as `null`.
- A draft left in the master input holds topic moves until it is sent or cleared.

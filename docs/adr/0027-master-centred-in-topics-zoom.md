# 0027 · The master sits in the centre of the topics zoom

**Status:** Accepted · 2026-10-27

## Context
In the topics zoom the master panel docked left and every topic stacked to its right (0017). Your eye goes to the master to read and answer what needs you, then out to a card and back again. With the master at the edge, a wide terminal pulls your eye far to one side and you have to find your place again each time you come back. The map zoom already puts the master in the centre (0018).

## Decision
- **Master in the centre.** When each side has room for at least a one-card bubble, the master panel sits in the middle of the screen. Topic bubbles go on both sides, and each side has its own trunk linked to the master's row. The left side mirrors the right: shelves grow leftwards from the master and buses run from the trunk to each bubble's `●`.
- **Splitting topics.** Topics go to a side neediest first, each to the side with fewer cards. Right wins a tie, so the neediest topic always sits right of the master.
- **Narrow terminals.** When the two sides would not both fit a bubble (under about 142 columns with the widest master), the master docks left as before.
- **Each side scrolls on its own.** The side with focus scrolls to the focused card. The other side centres on the master's row, or shows its top when it is too tall (0017).
- The arrow keys stay spatial (0026): from the master, `←` goes to the left side and `→` to the right. `[` `]` still cycle topics in attention order, across both sides.

## Consequences
- This replaces 0017's "Master stays docked left" for terminals wide enough to centre it.
- Each side is about half the room the right side used to have, so a bubble fits fewer cards in a row and a busy repo scrolls sooner.

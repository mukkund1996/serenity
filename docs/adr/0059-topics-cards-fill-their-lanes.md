# 0059 · Topic cards stretch to fill their side's lanes

**Status:** Accepted · 2026-11-03

## Context
Cards in the topics zoom were a fixed 40 columns, with 3 columns of padding inside a bubble and 5 between bubbles. Since the master moved to the centre (0027), each side is about half the screen. On a 255-column terminal a side is 91 columns wide: two 40-column cards did not fit, so every bubble held one column of cards and the bubbles stacked in a single column. About 40 columns on the outer edge of each side stayed empty while the stack ran past the bottom of the screen.

## Decision
- **Lanes.** Each side is cut into as many lanes as fit a one-card bubble at the minimum card width, 36 columns. A bubble holds up to that many cards in a row, and one-card bubbles of different topics sit side by side, still neediest first, each on the first shelf with room for it.
- **Cards stretch.** All cards on a side share one width, the width that fills its lanes, up to 56 columns. A side that holds one lane gets one wide card instead of a 40-column card and an empty margin; wider cards also wrap their text into fewer rows.
- **Tighter spacing.** The padding inside a bubble is 2 columns, the gap between bubbles 3 and between cards 3.
- **Centring threshold.** A side now needs 46 columns for a one-card bubble, so the master centres from about 164 columns with the widest master.

## Consequences
- On a 255-column terminal each side holds two lanes of 37-column cards, and a repo that overflowed the screen fits on it.
- At the minimum width a card's name has 18 columns before its chips, 4 fewer than before.
- A bubble with more cards than lanes can leave one cell of its last row empty, as before.

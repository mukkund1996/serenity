# 0003 · Hybrid rendering: cell canvas for the map, Ink for panels

**Status:** Accepted · 2026-10-25

## Context
The map and topics zooms place bubbles at exact cell positions and join them with right-angle box-drawing links (`─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴`, end dot `●`). The canvas specifies positions directly in cells (1 col = 1ch, 1 row = 17px). Panels, inputs and overlays are ordinary stacked layouts.

## Decision
- **Map layer:** our own cell-grid canvas in `core` — a 2D buffer of `{char, fg, bg, bold, inverse}` cells. Bubbles, cards and links are drawn into it; a layout engine computes positions. Ink renders the buffer as lines.
- **Everything else** (master panel, header/footer, overlays 4a–4e, forms): Ink components.
- Overlays composite over the canvas (Ink absolute box on top).

## Consequences
- The layout engine (bubble placement, link routing, junction characters) is pure and unit-testable against the canvas layouts (column / diagonal / row / rail).
- Two rendering paths to keep visually consistent: share frame-drawing helpers (light, heavy, rounded, dashed, double) between canvas and Ink.

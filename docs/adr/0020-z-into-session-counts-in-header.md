# 0020 · `Z` into a session, session counts in the header, a roomier topics zoom

**Status:** Accepted · 2026-10-26

## Context
Using 0019 turned up three problems. `Z` zoomed in from the map to topics, but in the topics zoom it did nothing, though the next level in is the session. The master panel's SESSIONS section took rows for counts and the latest archived sessions, which are glanceable facts rather than things to act on, and `H` already lists every archived session. In the topics zoom, cards sat 2 columns apart and bubbles 2 columns apart, with shelves back to back, so the zoom read as cramped.

## Decision
- **`Z` on a card in the topics zoom attaches its session**, the same as `Enter` on the card. On the map, or on the master in topics, `Z` still zooms in to topics.
- **No SESSIONS section in the master panel.** The counts by status (`● 2 working · 1 idle · ✓ 2 done`) move to the header's right, beside `zoom:`. The archived rows go; `H` lists them. The rows left over in the master go to REVIEW, then MY PRS.
- **A roomier topics zoom.** Cards in a bubble are 4 columns apart (was 2), bubbles on a shelf are 5 apart (was 2) and start 5 columns from the edge (was 4), and a blank row separates a shelf from the next one's bus.

## Consequences
- The counts show in both zooms, since the header is shared.
- Fewer bubbles fit side by side on a shelf, so a wide topic wraps to a new shelf a little sooner.

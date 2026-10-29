# 0042 · The master shows three messages; the pulse eases in and out; text fields edit like a terminal line

**Status:** Accepted · 2026-10-29 · Amends [0039](0039-pulse-on-master-session-messages.md) (the blink) and [0041](0041-master-chat-scrolls.md) (four messages, the hints)

## Context
Three things in the master panel and its inputs felt rough after a day of use.
- Four messages (0041) left REVIEW little room on an ordinary terminal, and the `↑ N more · PgUp` hint drew `PgUp` in bold white, as loud as the conversation it sat over.
- The pulse (0039) flashed a frame bright magenta and heavy, three times, on and off every 200 ms. It was noticed, but it was harsh.
- Every text field took typing and Backspace at its end and nothing else. Fixing a typo at the start of a message meant deleting the whole message.

## Decision
- **Three messages.** The topics zoom's master shows up to three messages; everything else in 0041 (the oldest giving way first, `PgUp` `PgDn`, keeping the place) stands.
- **Quiet hints.** `↑ N more · PgUp` and `↓ N newer · PgDn` are grey throughout, key names included, like the other secondary hints.
- **One swell, not three blinks.** A lit node's frame (and, on the map, the row's name) fades from a dusky magenta (`#875f87`) up to bright magenta (`#ff5fff`) and back over 1.4 s, eased with sin². Frames keep their own line weight: nothing turns heavy, so the only change is colour. Below 5 % the node keeps its own frame, so the pulse starts and ends without a jump. Two pings on one node show the brighter.
- **Still cheap.** The clock ticks every 70 ms while a pulse runs (20 renders per ping, up from 6) and stops when the latest ends; idle, nothing re-renders. The glow is rounded to 12 steps, so neighbouring frames often draw alike. Hex colours go through Ink's colour support: a 256-colour terminal shows fewer steps, a 16-colour one magenta.
- **Text fields edit like a terminal line.** One helper, `editField` in `text-input.ts`, edits a field and its cursor for every text field: the master input, a session's reply (card, NEEDS YOU, Slack draft, queued reply), the new session dialog and rename. Search keeps typing at its end.

  | Key | Does |
  |-----|------|
  | `←` `→` | A character back or on |
  | `Option+←` `→` (`Meta+b` `f`, `Ctrl+←` `→`) | A word back or on |
  | `Home` `End` (`Ctrl+a` `e`, `Cmd+←` `→` where the terminal reports Cmd) | The line's start or end |
  | `Backspace` `Delete` | The character before or after the cursor |
  | `Option+Backspace` (`Meta+d`, `Option+Delete` forward) | The word before (after) |
  | `Ctrl+w` | Back to the previous space, punctuation and all |
  | `Ctrl+u` (`Cmd+Backspace`) | To the line's start |
  | `Ctrl+k` | To the line's end |

  A word is letters, digits and `_`, as in readline. In the master's multi-line input "line" is the cursor's line, and `Ctrl+u` at a line's start or `Ctrl+k` at its end joins it to the next, as Backspace and Delete would. Typing and pasting go in at the cursor; Enter still sends, Shift+Enter (Alt+Enter, Ctrl+J) still starts a new line, at the cursor (0038). `↑` `↓` keep stepping the `@` list.
- **The cursor shows where it is.** After the text it is the `█` it always was; on a character, that character is drawn inverted. A one-row field too long for its row shows its end, or the part around the cursor once it moves back, with `…` where it is cut. The master's input keeps the cursor's row in view.
- **`@` completion reads up to the cursor.** The `@` list offers names for the `@word` just before the cursor, and Tab or Enter completes it there, keeping the text after the cursor.
- **A Ctrl key typed in a chunk with text still edits.** Ink passes a `Ctrl+e` that arrives in the same read as the next letters on inside the text; `editField` splits such a chunk and applies each key in turn, so fast typing over ssh does not leave control bytes in a message.

## Consequences
- `Cmd` reaches serenity only from terminals that send the kitty keyboard protocol. Elsewhere `Cmd+Backspace` works where the terminal maps it to `Ctrl+u`, and `Cmd+←` `→` where it maps them to Home and End, as several macOS terminals do or can be set to.
- Option sends Meta only when the terminal is set to (Apple Terminal: "Use Option as Meta key"; iTerm2: "Esc+"); otherwise Option+← → may not reach serenity as a word move at all.
- `Ctrl+u` in rename used to clear the whole name; it now clears what is before the cursor, which is the whole name while the cursor is at its end, where it starts.
- A pulse costs more renders than before; still none while idle.

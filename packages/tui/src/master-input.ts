/**
 * The master's message input: it grows to INPUT_MAX_ROWS lines, Shift+Enter
 * starts a new one (ADR 0038), and `@` opens a list of session names to tag
 * (ADR 0036).
 */

/** Lines the input grows to; a longer message shows its last lines. */
export const INPUT_MAX_ROWS = 4;
/** The cursor, drawn after the text. */
export const CURSOR = "█";
/** Columns taken by the "› " prompt, and by a continuation line's indent. */
export const PROMPT_W = 2;

/**
 * `text` and its cursor word-wrapped to `width` columns, up to `max` rows.
 * Each line of a multi-line message starts a row. A longer message keeps its
 * end in view, the first row starting with `…`. Rows after the first are
 * indented under the first row's text by the caller.
 */
export function inputRows(
	text: string,
	width: number,
	max = INPUT_MAX_ROWS,
): string[] {
	const w = Math.max(2, width);
	const rows = `${text}${CURSOR}`.split("\n").flatMap((line) => {
		const chars = [...line];
		const wrapped: string[] = [];
		let start = 0;
		while (chars.length - start > w) {
			// Break after the last space that fits; a word longer than a row is split.
			let end = start + w;
			for (let i = start + w; i > start; i--) {
				if (chars[i - 1] === " ") {
					end = i;
					break;
				}
			}
			wrapped.push(chars.slice(start, end).join(""));
			start = end;
		}
		wrapped.push(chars.slice(start).join(""));
		return wrapped;
	});
	if (rows.length <= max) return rows;
	const kept = rows.slice(-max);
	kept[0] = `…${[...(kept[0] as string)].slice(1).join("")}`;
	return kept;
}

/** The autocomplete's window: at most `max` names around the selection. */
export function listWindow(
	names: readonly string[],
	selected: number,
	max: number,
): { names: string[]; selected: number } {
	const start = Math.max(0, Math.min(selected - max + 1, names.length - max));
	return {
		names: names.slice(start, start + max),
		selected: selected - start,
	};
}

/** The selection after ↑ or ↓, wrapping round the list like Slack's. */
export function stepSelection(
	selected: number,
	count: number,
	delta: 1 | -1,
): number {
	if (count <= 0) return 0;
	return (selected + delta + count) % count;
}

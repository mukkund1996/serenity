/**
 * The master's message input: it grows to INPUT_MAX_ROWS lines, Shift+Enter
 * starts a new one (ADR 0038), and `@` opens a list of session names to tag
 * (ADR 0036).
 */

/** Lines the input grows to; a longer message shows its last lines. */
export const INPUT_MAX_ROWS = 4;
/** Columns taken by the "› " prompt, and by a continuation line's indent. */
export const PROMPT_W = 2;

/** One row of the input; `cursor` is the column the cursor is on, if it is on this row. */
export interface InputRow {
	text: string;
	cursor: number | null;
}

/**
 * `text` word-wrapped to `width` columns, up to `max` rows, with the cursor
 * at character `cursor` (the end when left out). Each line of a multi-line
 * message starts a row. The cursor takes a cell of its own after the text,
 * and at the end of the line it is on. A longer message keeps the cursor's
 * row in view, the end while the cursor is there; the first row starts with
 * `…` when rows above it are hidden. Rows after the first are indented under
 * the first row's text by the caller.
 */
export function inputRows(
	text: string,
	width: number,
	cursor?: number,
	max = INPUT_MAX_ROWS,
): InputRow[] {
	const w = Math.max(2, width);
	const lines = text.split("\n");
	const total = [...text].length;
	const at = Math.max(0, Math.min(cursor ?? total, total));
	const rows: InputRow[] = [];
	let offset = 0;
	lines.forEach((line, n) => {
		const chars = [...line];
		const here = at >= offset && at <= offset + chars.length;
		// The cursor's cell after the line, which wraps like a character.
		const cells =
			chars.length +
			(n === lines.length - 1 || (here && at === offset + chars.length)
				? 1
				: 0);
		const isSpace = (i: number) => i < chars.length && chars[i] === " ";
		let start = 0;
		const push = (end: number) => {
			const col =
				here && at - offset >= start && at - offset < end
					? at - offset - start
					: null;
			rows.push({ text: chars.slice(start, end).join(""), cursor: col });
			start = end;
		};
		while (cells - start > w) {
			// Break after the last space that fits; a word longer than a row is split.
			let end = start + w;
			for (let i = start + w; i > start; i--) {
				if (isSpace(i - 1)) {
					end = i;
					break;
				}
			}
			push(end);
		}
		push(cells);
		offset += chars.length + 1;
	});
	if (rows.length <= max) return rows;
	const cursorRow = rows.findIndex((r) => r.cursor !== null);
	const first = Math.max(0, Math.min(rows.length - max, cursorRow - max + 1));
	const kept = rows.slice(first, first + max);
	if (first > 0) {
		const top = kept[0] as InputRow;
		// Never the cursor's row: that one is at the bottom when rows scroll.
		kept[0] = { ...top, text: `…${[...top.text].slice(1).join("")}` };
	}
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

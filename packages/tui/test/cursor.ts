import type { Canvas } from "@serenity/core";
import type { InputRow } from "../src/master-input";
import { CURSOR_CELL } from "../src/text-input";

/**
 * The canvas as text with a character under the cursor marked `[x]`; the
 * cursor after the text is drawn `█` already.
 */
export function withCursor(canvas: Canvas): string {
	return canvas
		.rows()
		.map((runs) =>
			runs
				.map((run) =>
					run.style.bg === CURSOR_CELL.bg && run.style.fg === CURSOR_CELL.fg
						? [...run.text].map((c) => `[${c}]`).join("")
						: run.text,
				)
				.join("")
				.trimEnd(),
		)
		.join("\n");
}

/** Input rows as text, the cursor marked as withCursor marks it. */
export function showRows(rows: InputRow[]): string[] {
	return rows.map(({ text, cursor }) => {
		if (cursor === null) return text;
		const chars = [...text];
		if (cursor >= chars.length) return `${text}█`;
		return [
			...chars.slice(0, cursor),
			`[${chars[cursor]}]`,
			...chars.slice(cursor + 1),
		].join("");
	});
}

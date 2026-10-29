import type { Canvas, Style } from "@serenity/core";

/**
 * Splits a chunk of typed or pasted input at its first line break. tmux and
 * terminals can deliver "text\r" as one chunk, in which case Ink never reports
 * a separate Return key.
 */
export function splitAtNewline(input: string): {
	text: string;
	submit: boolean;
} {
	const at = input.search(/[\r\n]/);
	if (at === -1) return { text: input, submit: false };
	return { text: input.slice(0, at), submit: true };
}

/**
 * Whether a key starts a new line in a multi-line input instead of sending
 * it (ADR 0038): Shift+Enter, which tmux passes to the map as a CSI u key;
 * Alt+Enter; and Ctrl+J, which every terminal sends as a bare line feed.
 */
export function isNewlineKey(
	input: string,
	key: { return: boolean; shift: boolean; meta: boolean },
): boolean {
	return (key.return && (key.shift || key.meta)) || input === "\n";
}

/**
 * A text field and its cursor (ADR 0042). `cursor` counts characters (code
 * points) from the start, so an emoji is one step; it may equal the text's
 * length, after the last character.
 */
export interface Field {
	text: string;
	cursor: number;
}

/** `text` with the cursor after its last character. */
export function fieldAt(text: string): Field {
	return { text, cursor: [...text].length };
}

/** The keys editField reads, as Ink reports them. */
export interface EditKey {
	leftArrow: boolean;
	rightArrow: boolean;
	home: boolean;
	end: boolean;
	backspace: boolean;
	delete: boolean;
	ctrl: boolean;
	meta: boolean;
	/** Cmd, when the terminal reports it (kitty keyboard protocol). */
	super?: boolean;
}

const WORD = /[\p{L}\p{N}_]/u;
const SPACE = /\s/u;

/** Where a move by word from `at` lands: over non-word characters, then a word. */
function wordStep(chars: string[], at: number, back: boolean): number {
	const isWord = (i: number) => WORD.test(chars[i] as string);
	let i = at;
	if (back) {
		while (i > 0 && !isWord(i - 1)) i--;
		while (i > 0 && isWord(i - 1)) i--;
	} else {
		while (i < chars.length && !isWord(i)) i++;
		while (i < chars.length && isWord(i)) i++;
	}
	return i;
}

/** Ctrl+W's word: back over spaces, then over everything up to a space. */
function spaceWordStart(chars: string[], at: number): number {
	let i = at;
	while (i > 0 && SPACE.test(chars[i - 1] as string)) i--;
	while (i > 0 && !SPACE.test(chars[i - 1] as string)) i--;
	return i;
}

/** The start and end of the line holding `at`; a multi-line text's lines are its own. */
function lineBounds(chars: string[], at: number): [number, number] {
	let start = at;
	while (start > 0 && chars[start - 1] !== "\n") start--;
	let end = at;
	while (end < chars.length && chars[end] !== "\n") end++;
	return [start, end];
}

/** `chars` without the characters between `a` and `b`, the cursor at the gap. */
function cut(chars: string[], a: number, b: number): Field {
	const [from, to] = a < b ? [a, b] : [b, a];
	return {
		text: [...chars.slice(0, from), ...chars.slice(to)].join(""),
		cursor: from,
	};
}

/** `text` typed or pasted at the cursor. */
export function insertText(field: Field, text: string): Field {
	const chars = [...field.text];
	const at = Math.min(field.cursor, chars.length);
	return {
		text: [...chars.slice(0, at), text, ...chars.slice(at)].join(""),
		cursor: at + [...text].length,
	};
}

/**
 * A text field's keys (ADR 0042), the terminal's usual ones: ← → move a
 * character, Option+← → (Meta+b f, Ctrl+← →) a word, Home End (Ctrl+a e) to
 * the line's start and end; Backspace and Delete remove a character either
 * side, Option+Backspace (Meta+d forward) a word, Ctrl+W the word before
 * up to a space, Ctrl+U (Cmd+Backspace) to the line's start, Ctrl+K to its
 * end. Anything else typed is inserted at the cursor; a line break in it
 * submits the text before the break. Null when the key is not an edit.
 */
export function editField(
	field: Field,
	input: string,
	key: EditKey,
): { field: Field; submit: boolean } | null {
	const chars = [...field.text];
	const at = Math.max(0, Math.min(field.cursor, chars.length));
	const [lineStart, lineEnd] = lineBounds(chars, at);
	const word = key.meta || key.ctrl;
	const move = (cursor: number) => ({
		field: { text: field.text, cursor },
		submit: false,
	});
	const remove = (to: number) => ({ field: cut(chars, at, to), submit: false });

	if (key.leftArrow) {
		if (key.super) return move(lineStart);
		return move(word ? wordStep(chars, at, true) : Math.max(0, at - 1));
	}
	if (key.rightArrow) {
		if (key.super) return move(lineEnd);
		return move(
			word ? wordStep(chars, at, false) : Math.min(chars.length, at + 1),
		);
	}
	if (key.home || (key.ctrl && input === "a")) return move(lineStart);
	if (key.end || (key.ctrl && input === "e")) return move(lineEnd);
	if (key.meta && input === "b") return move(wordStep(chars, at, true));
	if (key.meta && input === "f") return move(wordStep(chars, at, false));

	if (key.backspace) {
		// At a line's start these remove the line break before it, like Backspace.
		if (key.super)
			return remove(at > lineStart ? lineStart : Math.max(0, at - 1));
		if (key.meta) return remove(wordStep(chars, at, true));
		return remove(Math.max(0, at - 1));
	}
	if (key.delete) {
		if (key.meta) return remove(wordStep(chars, at, false));
		return remove(Math.min(chars.length, at + 1));
	}
	if (key.meta && input === "d") return remove(wordStep(chars, at, false));
	if (key.ctrl && input === "w") return remove(spaceWordStart(chars, at));
	if (key.ctrl && input === "u")
		return remove(at > lineStart ? lineStart : Math.max(0, at - 1));
	if (key.ctrl && input === "k")
		return remove(at < lineEnd ? lineEnd : Math.min(chars.length, at + 1));

	if (!input || key.ctrl || key.meta) return null;
	if ([...input].some(isCtrlLetter)) return editChunk(field, input, key);
	const { text, submit } = splitAtNewline(input);
	return { field: insertText({ text: field.text, cursor: at }, text), submit };
}

/**
 * A Ctrl+letter byte, other than Tab, line feed and Enter, which text keeps.
 * Ink passes one that arrives in a chunk with text on inside the text.
 */
function isCtrlLetter(c: string): boolean {
	const code = c.charCodeAt(0);
	return code >= 1 && code <= 26 && c !== "\t" && c !== "\n" && c !== "\r";
}

/**
 * A chunk of text with Ctrl+letter keys in it, typed faster than one key a
 * chunk: each key and each run of text applied in turn, stopping at a submit.
 * A Ctrl key that is not an edit is dropped.
 */
function editChunk(
	field: Field,
	input: string,
	key: EditKey,
): { field: Field; submit: boolean } {
	let next = field;
	let text = "";
	const apply = (chunk: string, k: EditKey) => {
		const edit = editField(next, chunk, k);
		if (edit) next = edit.field;
		return edit?.submit ?? false;
	};
	for (const c of input) {
		if (!isCtrlLetter(c)) {
			text += c;
			continue;
		}
		if (text && apply(text, key)) return { field: next, submit: true };
		text = "";
		const letter = String.fromCharCode(c.charCodeAt(0) + 96);
		apply(letter, { ...key, ctrl: true });
	}
	const submit = !!text && apply(text, key);
	return { field: next, submit };
}

/** The cursor after the text, as it has always been drawn. */
export const CURSOR = "█";

/**
 * A one-row field in `width` columns, split around the cursor: `at` is the
 * character under it, drawn inverted, or null when the cursor is after the
 * text, where CURSOR is drawn. A text too long for the
 * row shows its end, or the part around the cursor once it moves back, with
 * `…` where it is cut. Line breaks show as `↵`.
 */
export function fieldWindow(
	field: Field,
	width: number,
): { before: string; at: string | null; after: string } {
	const chars = [...field.text].map((c) => (c === "\n" ? "↵" : c));
	const cursor = Math.max(0, Math.min(field.cursor, chars.length));
	// The cursor takes a cell of its own after the text.
	const cells = [...chars, " "];
	const w = Math.max(3, width);
	let start = 0;
	if (cells.length > w) {
		start = cells.length - w;
		// Keep a cell for the leading "…" before the cursor.
		if (cursor < start + 1) start = Math.max(0, cursor - 1);
	}
	const shown = cells.slice(start, start + w);
	if (start > 0) shown[0] = "…";
	if (start + w < cells.length) shown[w - 1] = "…";
	const c = cursor - start;
	// The cell after the text is only drawn when the cursor is on it.
	const tail =
		start + w >= cells.length && c < shown.length - 1 ? -1 : undefined;
	return {
		before: shown.slice(0, c).join(""),
		at: cursor === chars.length ? null : (shown[c] ?? " "),
		after: shown.slice(c + 1, tail).join(""),
	};
}

/** The character under the cursor on a canvas: the field's colours swapped. */
export const CURSOR_CELL: Style = { fg: "black", bg: "whiteBright" };

/**
 * A one-row reply field on a canvas, `width` columns from (x, y): "› " and
 * the text, white on black, the character under the cursor inverted (CURSOR
 * after the text). A null field is the empty prompt, not yet typed into.
 */
export function drawField(
	canvas: Canvas,
	x: number,
	y: number,
	width: number,
	field: Field | null,
): void {
	const style: Style = { fg: "whiteBright", bg: "black" };
	canvas.fill(x, y, width, 1, { bg: "black" });
	let col = canvas.text(x, y, "› ", style);
	if (field === null) return;
	const { before, at, after } = fieldWindow(field, width - 2);
	col = canvas.text(col, y, before, style);
	col = canvas.text(col, y, at ?? CURSOR, at === null ? style : CURSOR_CELL);
	canvas.text(col, y, after, style);
}

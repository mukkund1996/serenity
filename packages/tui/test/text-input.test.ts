import { describe, expect, test } from "bun:test";
import {
	type EditKey,
	editField,
	type Field,
	fieldAt,
	fieldWindow,
	insertText,
	isNewlineKey,
	splitAtNewline,
} from "../src/text-input";

const key = (
	k: Partial<{ return: boolean; shift: boolean; meta: boolean }>,
) => ({
	return: false,
	shift: false,
	meta: false,
	...k,
});

describe("isNewlineKey", () => {
	test("Shift+Enter, Alt+Enter and Ctrl+J start a new line", () => {
		expect(isNewlineKey("\r", key({ return: true, shift: true }))).toBe(true);
		expect(isNewlineKey("\r", key({ return: true, meta: true }))).toBe(true);
		expect(isNewlineKey("\n", key({}))).toBe(true);
	});

	test("plain Enter, and text with a line break in it, do not", () => {
		expect(isNewlineKey("\r", key({ return: true }))).toBe(false);
		expect(isNewlineKey("done\r", key({}))).toBe(false);
		expect(isNewlineKey("a", key({ shift: true }))).toBe(false);
	});
});

describe("splitAtNewline", () => {
	test("a chunk ending in Enter submits the text before it", () => {
		expect(splitAtNewline("status?\r")).toEqual({
			text: "status?",
			submit: true,
		});
		expect(splitAtNewline("abc")).toEqual({ text: "abc", submit: false });
	});
});

const none: EditKey = {
	leftArrow: false,
	rightArrow: false,
	home: false,
	end: false,
	backspace: false,
	delete: false,
	ctrl: false,
	meta: false,
	super: false,
};

/** `text` with `|` marking the cursor, as a field. */
const at = (marked: string): Field => ({
	text: marked.replace("|", ""),
	cursor: [...marked].indexOf("|"),
});
/** A field shown with `|` at its cursor. */
const show = ({ text, cursor }: Field) => {
	const chars = [...text];
	return [...chars.slice(0, cursor), "|", ...chars.slice(cursor)].join("");
};
/** The field after one key, shown; the field unchanged when the key is not an edit. */
const press = (marked: string, input: string, k: Partial<EditKey> = {}) => {
	const edit = editField(at(marked), input, { ...none, ...k });
	return edit ? show(edit.field) : null;
};

describe("editField", () => {
	test("typing and pasting insert at the cursor", () => {
		expect(press("hel|o", "l")).toBe("hell|o");
		expect(press("|world", "hello ")).toBe("hello |world");
		expect(press("ab|", "c")).toBe("abc|");
	});

	test("a line break in a chunk submits the text before it, inserted at the cursor", () => {
		const edit = editField(at("say |there"), "hi \r", none);
		expect(edit?.submit).toBe(true);
		expect(edit?.field.text).toBe("say hi there");
	});

	test("← → move a character, and stop at the ends", () => {
		expect(press("ab|c", "", { leftArrow: true })).toBe("a|bc");
		expect(press("ab|c", "", { rightArrow: true })).toBe("abc|");
		expect(press("|abc", "", { leftArrow: true })).toBe("|abc");
		expect(press("abc|", "", { rightArrow: true })).toBe("abc|");
	});

	test("an emoji is one step", () => {
		expect(press("a🙂|", "", { leftArrow: true })).toBe("a|🙂");
		expect(press("a🙂|", "", { backspace: true })).toBe("a|");
	});

	test("Option+← → (Meta+b f, Ctrl+← →) move a word", () => {
		expect(press("fix the bug|", "", { leftArrow: true, meta: true })).toBe(
			"fix the |bug",
		);
		expect(press("fix the |bug", "b", { meta: true })).toBe("fix |the bug");
		expect(press("|fix the bug", "", { rightArrow: true, meta: true })).toBe(
			"fix| the bug",
		);
		expect(press("fix| the bug", "f", { meta: true })).toBe("fix the| bug");
		expect(press("api-auth now|", "", { leftArrow: true, ctrl: true })).toBe(
			"api-auth |now",
		);
		expect(press("@api|-auth", "b", { meta: true })).toBe("@|api-auth");
	});

	test("Home End and Ctrl+a e go to the line's start and end", () => {
		expect(press("ab|cd", "", { home: true })).toBe("|abcd");
		expect(press("ab|cd", "", { end: true })).toBe("abcd|");
		expect(press("ab|cd", "a", { ctrl: true })).toBe("|abcd");
		expect(press("ab|cd", "e", { ctrl: true })).toBe("abcd|");
		expect(press("ab|cd", "", { leftArrow: true, super: true })).toBe("|abcd");
		expect(press("ab|cd", "", { rightArrow: true, super: true })).toBe("abcd|");
	});

	test("in a multi-line message they keep to the cursor's line", () => {
		expect(press("one\ntw|o\nthree", "", { home: true })).toBe(
			"one\n|two\nthree",
		);
		expect(press("one\ntw|o\nthree", "e", { ctrl: true })).toBe(
			"one\ntwo|\nthree",
		);
		expect(press("one\ntw|o", "u", { ctrl: true })).toBe("one\n|o");
		expect(press("one\ntw|o\nthree", "k", { ctrl: true })).toBe(
			"one\ntw|\nthree",
		);
	});

	test("Backspace and Delete remove a character either side", () => {
		expect(press("ab|c", "", { backspace: true })).toBe("a|c");
		expect(press("ab|c", "", { delete: true })).toBe("ab|");
		expect(press("|abc", "", { backspace: true })).toBe("|abc");
		expect(press("abc|", "", { delete: true })).toBe("abc|");
	});

	test("Option+Backspace removes the word before; Meta+d and Option+Delete the one after", () => {
		expect(press("fix the bug|", "", { backspace: true, meta: true })).toBe(
			"fix the |",
		);
		expect(press("fix the |bug", "", { backspace: true, meta: true })).toBe(
			"fix |bug",
		);
		expect(press("fix |the bug", "d", { meta: true })).toBe("fix | bug");
		expect(press("fix |the bug", "", { delete: true, meta: true })).toBe(
			"fix | bug",
		);
	});

	test("Ctrl+W removes back to a space, punctuation and all", () => {
		expect(press("ask @api-auth|", "w", { ctrl: true })).toBe("ask |");
		expect(press("ask @api-auth  |", "w", { ctrl: true })).toBe("ask |");
	});

	test("Ctrl+U (Cmd+Backspace) removes to the line's start, Ctrl+K to its end", () => {
		expect(press("hello |world", "u", { ctrl: true })).toBe("|world");
		expect(press("hello |world", "", { backspace: true, super: true })).toBe(
			"|world",
		);
		expect(press("hello |world", "k", { ctrl: true })).toBe("hello |");
	});

	test("at a line's edge, Ctrl+U and Ctrl+K join it to the next line", () => {
		expect(press("one\n|two", "u", { ctrl: true })).toBe("one|two");
		expect(press("one|\ntwo", "k", { ctrl: true })).toBe("one|two");
	});

	test("Ctrl keys typed in one chunk with text still edit, in order", () => {
		expect(press("ok |status", "\x05?")).toBe("ok status?|");
		expect(press("abc|", "x\x01y")).toBe("y|abcx");
		// An unknown Ctrl key is dropped, not typed.
		expect(press("|", "a\x18b")).toBe("ab|");
		const edit = editField(at("|"), "go\x05\r", none);
		expect(edit).toEqual({ field: { text: "go", cursor: 2 }, submit: true });
	});

	test("other control and meta keys are not edits", () => {
		expect(press("ab|", "x", { ctrl: true })).toBeNull();
		expect(press("ab|", "x", { meta: true })).toBeNull();
		expect(press("ab|", "")).toBeNull();
	});
});

describe("insertText", () => {
	test("puts the cursor after what it inserted", () => {
		expect(show(insertText(at("one|two"), "\n"))).toBe("one\n|two");
	});
});

describe("fieldAt", () => {
	test("puts the cursor at the end", () => {
		expect(fieldAt("hé🙂")).toEqual({ text: "hé🙂", cursor: 3 });
	});
});

describe("fieldWindow", () => {
	const win = (marked: string, width: number) => {
		const { before, at: on, after } = fieldWindow(at(marked), width);
		return `${before}${on === null ? "█" : `[${on}]`}${after}`;
	};

	test("a short text shows whole, the cursor after it or on a character", () => {
		expect(win("abc|", 10)).toBe("abc█");
		expect(win("a|bc", 10)).toBe("a[b]c");
	});

	test("a long text shows its end while the cursor is there", () => {
		expect(win("abcdefghij|", 6)).toBe("…ghij█");
	});

	test("moving back scrolls the window to keep the cursor in view", () => {
		expect(win("abcdefghij|", 6).length).toBeLessThanOrEqual(8);
		expect(win("abc|defghij", 6)).toBe("…[d]efg…");
		expect(win("|abcdefghij", 6)).toBe("[a]bcde…");
	});

	test("line breaks show as ↵", () => {
		expect(win("a\nb|", 10)).toBe("a↵b█");
	});
});

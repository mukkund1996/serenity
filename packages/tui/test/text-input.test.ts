import { describe, expect, test } from "bun:test";
import { isNewlineKey, splitAtNewline } from "../src/text-input";

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

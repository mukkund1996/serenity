import { describe, expect, test } from "bun:test";
import {
	INPUT_MAX_ROWS,
	inputRows,
	listWindow,
	stepSelection,
} from "../src/master-input";
import { showRows } from "./cursor";

const rowsOf = (text: string, width: number, cursor?: number) =>
	showRows(inputRows(text, width, cursor));

describe("inputRows", () => {
	test("a short message is one row, the cursor after it", () => {
		expect(rowsOf("hello", 20)).toEqual(["hello█"]);
		expect(rowsOf("", 20)).toEqual(["█"]);
	});

	test("wraps at spaces and loses no character", () => {
		const rows = rowsOf("one two three four five", 10);
		expect(rows).toEqual(["one two ", "three ", "four five█"]);
		expect(rows.join("")).toBe("one two three four five█");
		for (const row of rows) expect([...row].length).toBeLessThanOrEqual(10);
	});

	test("splits a word longer than a row", () => {
		const rows = rowsOf("abcdefghijklmnop", 6);
		expect(rows.join("")).toBe("abcdefghijklmnop█");
		expect(rows.every((r) => [...r].length <= 6)).toBe(true);
	});

	test("grows up to four rows, then shows the last four behind an ellipsis", () => {
		const four = rowsOf("aaaa bbbb cccc dddd", 5);
		expect(four).toHaveLength(4);
		expect(four[0]).toBe("aaaa ");
		const more = rowsOf("aaaa bbbb cccc dddd eeee ffff", 5);
		expect(more).toHaveLength(INPUT_MAX_ROWS);
		expect(more[0]).toBe("…ccc ");
		expect(more.at(-1)).toBe("ffff█");
		expect(more.every((r) => [...r].length <= 5)).toBe(true);
	});

	test("the cursor wraps to a row of its own when the text fills the last row", () => {
		expect(rowsOf("abcde", 5)).toEqual(["abcde", "█"]);
	});

	test("each line of a multi-line message starts a row", () => {
		expect(rowsOf("one\ntwo", 20)).toEqual(["one", "two█"]);
		// After Shift+Enter the cursor waits at the start of the new line.
		expect(rowsOf("one\n", 20)).toEqual(["one", "█"]);
		expect(rowsOf("one\n\nthree", 20)).toEqual(["one", "", "three█"]);
	});

	test("a long line wraps within its own rows", () => {
		expect(rowsOf("one two three\nfour", 8)).toEqual([
			"one two ",
			"three",
			"four█",
		]);
	});

	test("lines count toward the four rows; more show the last four", () => {
		const rows = rowsOf("a\nb\nc\nd\ne", 20);
		expect(rows).toEqual(["…", "c", "d", "e█"]);
	});

	test("the cursor sits on the character it is before, in its row", () => {
		expect(rowsOf("hello", 20, 0)).toEqual(["[h]ello"]);
		expect(rowsOf("one two three", 8, 9)).toEqual(["one two ", "t[h]ree"]);
		expect(rowsOf("one\ntwo", 20, 1)).toEqual(["o[n]e", "two"]);
	});

	test("at the end of a line that is not the last, the cursor takes a cell after it", () => {
		expect(rowsOf("one\ntwo", 20, 3)).toEqual(["one█", "two"]);
	});

	test("a long message keeps the cursor's row in view as it moves back", () => {
		const text = "a\nb\nc\nd\ne\nf";
		expect(rowsOf(text, 20, 0)).toEqual(["[a]", "b", "c", "d"]);
		expect(rowsOf(text, 20, 8)).toEqual(["…", "c", "d", "[e]"]);
		expect(rowsOf(text, 20)).toEqual(["…", "d", "e", "f█"]);
	});
});

describe("listWindow", () => {
	const names = ["a", "b", "c", "d", "e", "f"];

	test("shows the first rows while the selection is among them", () => {
		expect(listWindow(names, 0, 4)).toEqual({
			names: ["a", "b", "c", "d"],
			selected: 0,
		});
		expect(listWindow(names, 3, 4).selected).toBe(3);
	});

	test("slides to keep the selection shown", () => {
		expect(listWindow(names, 5, 4)).toEqual({
			names: ["c", "d", "e", "f"],
			selected: 3,
		});
	});

	test("a short list is shown whole", () => {
		expect(listWindow(["a", "b"], 1, 4)).toEqual({
			names: ["a", "b"],
			selected: 1,
		});
	});
});

describe("stepSelection", () => {
	test("moves and wraps round the list", () => {
		expect(stepSelection(0, 3, 1)).toBe(1);
		expect(stepSelection(2, 3, 1)).toBe(0);
		expect(stepSelection(0, 3, -1)).toBe(2);
		expect(stepSelection(0, 0, 1)).toBe(0);
	});
});

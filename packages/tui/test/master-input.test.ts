import { describe, expect, test } from "bun:test";
import {
	INPUT_MAX_ROWS,
	inputRows,
	listWindow,
	stepSelection,
} from "../src/master-input";

describe("inputRows", () => {
	test("a short message is one row, the cursor after it", () => {
		expect(inputRows("hello", 20)).toEqual(["hello█"]);
		expect(inputRows("", 20)).toEqual(["█"]);
	});

	test("wraps at spaces and loses no character", () => {
		const rows = inputRows("one two three four five", 10);
		expect(rows).toEqual(["one two ", "three ", "four five█"]);
		expect(rows.join("")).toBe("one two three four five█");
		for (const row of rows) expect([...row].length).toBeLessThanOrEqual(10);
	});

	test("splits a word longer than a row", () => {
		const rows = inputRows("abcdefghijklmnop", 6);
		expect(rows.join("")).toBe("abcdefghijklmnop█");
		expect(rows.every((r) => [...r].length <= 6)).toBe(true);
	});

	test("grows up to four rows, then shows the last four behind an ellipsis", () => {
		const four = inputRows("aaaa bbbb cccc dddd", 5);
		expect(four).toHaveLength(4);
		expect(four[0]).toBe("aaaa ");
		const more = inputRows("aaaa bbbb cccc dddd eeee ffff", 5);
		expect(more).toHaveLength(INPUT_MAX_ROWS);
		expect(more[0]).toBe("…ccc ");
		expect(more.at(-1)).toBe("ffff█");
		expect(more.every((r) => [...r].length <= 5)).toBe(true);
	});

	test("the cursor wraps to a row of its own when the text fills the last row", () => {
		expect(inputRows("abcde", 5)).toEqual(["abcde", "█"]);
	});

	test("each line of a multi-line message starts a row", () => {
		expect(inputRows("one\ntwo", 20)).toEqual(["one", "two█"]);
		// After Shift+Enter the cursor waits at the start of the new line.
		expect(inputRows("one\n", 20)).toEqual(["one", "█"]);
		expect(inputRows("one\n\nthree", 20)).toEqual(["one", "", "three█"]);
	});

	test("a long line wraps within its own rows", () => {
		expect(inputRows("one two three\nfour", 8)).toEqual([
			"one two ",
			"three",
			"four█",
		]);
	});

	test("lines count toward the four rows; more show the last four", () => {
		const rows = inputRows("a\nb\nc\nd\ne", 20);
		expect(rows).toEqual(["…", "c", "d", "e█"]);
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

import { describe, expect, test } from "bun:test";
import { makeSession } from "@serenity/core/testing";
import {
	INPUT_MAX_ROWS,
	inputRows,
	listColor,
	listWindow,
	mentionColors,
	rowRuns,
	stepSelection,
} from "../src/master-input";
import { MENTION_COLOR } from "../src/theme";
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

describe("mention colours (ADR 0052)", () => {
	const sessions = [
		makeSession({ id: "a", name: "api-auth", status: "idle" }),
		makeSession({ id: "o", name: "old", status: "archived" }),
	];

	test("a session blue, @new green, @copy and @handover yellow", () => {
		expect(MENTION_COLOR).toEqual({
			session: "blueBright",
			new: "green",
			copy: "yellow",
			handover: "yellow",
		});
		expect(listColor("api-auth")).toBe("blueBright");
		expect(listColor("new")).toBe("green");
		expect(listColor("copy")).toBe("yellow");
		expect(listColor("handover")).toBe("yellow");
	});

	test("each character gets its mention's colour; unknown @words stay plain", () => {
		const B = "blueBright";
		const G = "green";
		expect(mentionColors("@new @api-auth, @old @x", sessions)).toEqual([
			...Array(4).fill(G),
			null,
			...Array(9).fill(B),
			...Array(" , @old @x".length - 1).fill(null),
		]);
		expect(mentionColors("@api", sessions).every((c) => c === null)).toBe(true);
	});

	test("rows know where they start, so wrapped rows keep their colours", () => {
		const text = "tell @api-auth to go";
		const rows = inputRows(text, 10);
		expect(rows.map((r) => r.start)).toEqual([0, 5, 15]);
		const colors = mentionColors(text, sessions);
		expect(rowRuns(rows[1] as (typeof rows)[number], colors)).toEqual([
			{ text: "@api-auth", color: "blueBright", cursor: false },
			{ text: " ", color: null, cursor: false },
		]);
	});

	test("the character under the cursor is a run of its own", () => {
		const text = "@new go";
		const [row] = inputRows(text, 40, 2);
		expect(
			rowRuns(row as NonNullable<typeof row>, mentionColors(text, sessions)),
		).toEqual([
			{ text: "@n", color: "green", cursor: false },
			{ text: "e", color: "green", cursor: true },
			{ text: "w", color: "green", cursor: false },
			{ text: " go", color: null, cursor: false },
		]);
	});
});

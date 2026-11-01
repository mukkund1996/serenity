import { describe, expect, test } from "bun:test";
import { Canvas, truncate, wrap } from "../src/canvas";

describe("Canvas", () => {
	test("draws frames and clips text", () => {
		const c = new Canvas(8, 3);
		c.frame(0, 0, 6, 3, "rounded");
		c.text(1, 1, "hello world");
		expect(c.toString()).toBe("╭────╮\n│hello w\n╰────╯");
	});

	test("merges equal styles into runs", () => {
		const c = new Canvas(4, 1);
		c.text(0, 0, "ab", { fg: "yellow" });
		c.text(2, 0, "cd", { fg: "yellow" });
		expect(c.rows()[0]).toEqual([{ text: "abcd", style: { fg: "yellow" } }]);
	});
});

describe("text helpers", () => {
	test("truncate adds an ellipsis", () => {
		expect(truncate("abcdef", 4)).toBe("abc…");
		expect(truncate("abc", 4)).toBe("abc");
	});

	test("wrap caps lines and truncates the last", () => {
		expect(wrap("one two three four five", 9, 2)).toEqual([
			"one two",
			"three fo…",
		]);
		expect(wrap("short", 9, 2)).toEqual(["short"]);
	});

	test("wrap breaks a word longer than the line", () => {
		const lines = wrap(
			"doc is at /a/very/long/path/to/handover.md. Done",
			10,
			3,
		);
		expect(lines).toEqual(["doc is at", "/a/very/lo", "ng/path/t…"]);
		for (const line of lines) expect([...line].length).toBeLessThanOrEqual(10);
		expect(wrap("abcdefghij klm", 4, 5)).toEqual(["abcd", "efgh", "ij", "klm"]);
	});
});

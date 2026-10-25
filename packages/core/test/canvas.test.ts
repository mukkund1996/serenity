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
});

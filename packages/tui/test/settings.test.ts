import { expect, test } from "bun:test";
import { modelChoices, SETTINGS_ROWS, stepChoice } from "../src/settings";

test("stepChoice wraps round both ways and starts from the first for an unknown value", () => {
	const list = ["a", "b", "c"];
	expect(stepChoice(list, "c", 1)).toBe("a");
	expect(stepChoice(list, "a", -1)).toBe("c");
	expect(stepChoice(list, "x", 1)).toBe("b");
	expect(stepChoice(SETTINGS_ROWS, "slack", 1)).toBe("baseRepo");
});

test("a custom model id from the file stays one of the choices", () => {
	expect(modelChoices("sonnet")).toEqual(["opus", "sonnet", "haiku"]);
	expect(modelChoices("claude-x-1")).toEqual([
		"opus",
		"sonnet",
		"haiku",
		"claude-x-1",
	]);
});

import { expect, test } from "bun:test";
import { shortDuration, usageParts } from "../src/usage";

test("short durations", () => {
	expect(shortDuration(45_000)).toBe("45s");
	expect(shortDuration(3 * 60_000 + 59_000)).toBe("3m");
	expect(shortDuration(65 * 60_000)).toBe("1h05m");
	expect(shortDuration(51 * 3_600_000)).toBe("2d3h");
});

test("usage bar: dashes before anything is known", () => {
	expect(usageParts(null, null, 0).map((p) => [p.label, p.value])).toEqual([
		["session", "—"],
		["week", "—"],
		["avg wait", "—"],
	]);
});

test("usage bar: high limits turn yellow or red and show their reset", () => {
	const now = 1_000_000;
	const parts = usageParts(
		{
			session: { usedPercent: 82.4, resetsAt: now + 65 * 60_000 },
			week: { usedPercent: 97, resetsAt: null },
			at: now,
		},
		150_000,
		now,
	);
	expect(parts).toEqual([
		{ label: "session", value: "82% ↻1h05m", color: "yellow" },
		{ label: "week", value: "97%", color: "red" },
		{ label: "avg wait", value: "2m", color: "whiteBright" },
	]);
});

test("usage bar: a limit past its reset shows 0%", () => {
	const parts = usageParts(
		{ session: { usedPercent: 99, resetsAt: 10 }, week: null, at: 0 },
		null,
		20,
	);
	expect(parts[0]).toEqual({
		label: "session",
		value: "0%",
		color: "whiteBright",
	});
});

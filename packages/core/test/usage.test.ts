import { expect, test } from "bun:test";
import {
	averageWait,
	currentWindow,
	parseRateLimits,
	usageChanged,
	waitChange,
} from "../src/usage";
import { makeSession } from "../test-support";

test("rate limits: percent and reset in ms, from seconds or an ISO date", () => {
	expect(
		parseRateLimits(
			{
				five_hour: { used_percentage: 42.5, resets_at: 1_800_000_000 },
				seven_day: {
					used_percentage: 120,
					resets_at: "2027-01-01T00:00:00Z",
				},
			},
			7,
		),
	).toEqual({
		session: { usedPercent: 42.5, resetsAt: 1_800_000_000_000 },
		week: { usedPercent: 100, resetsAt: Date.parse("2027-01-01T00:00:00Z") },
		at: 7,
	});
});

test("rate limits: a missing window is null; none at all is no usage", () => {
	expect(
		parseRateLimits({ seven_day: { used_percentage: 3 } }, 1),
	).toMatchObject({ session: null, week: { usedPercent: 3, resetsAt: null } });
	expect(parseRateLimits(null, 1)).toBeNull();
	expect(
		parseRateLimits({ five_hour: { used_percentage: "x" } }, 1),
	).toBeNull();
});

test("usage changes on its numbers, not on when it was reported", () => {
	const a = parseRateLimits({ five_hour: { used_percentage: 4 } }, 1);
	const b = parseRateLimits({ five_hour: { used_percentage: 4 } }, 2);
	const c = parseRateLimits({ five_hour: { used_percentage: 5 } }, 3);
	if (!a || !b || !c) throw new Error("parsed");
	expect(usageChanged(null, a)).toBe(true);
	expect(usageChanged(a, b)).toBe(false);
	expect(usageChanged(b, c)).toBe(true);
});

test("a window past its reset reads 0", () => {
	const w = { usedPercent: 90, resetsAt: 100 };
	expect(currentWindow(w, 99)).toEqual(w);
	expect(currentWindow(w, 100)).toEqual({ usedPercent: 0, resetsAt: null });
	expect(currentWindow({ usedPercent: 9, resetsAt: null }, 1e15)).toEqual({
		usedPercent: 9,
		resetsAt: null,
	});
});

test("a wait starts on entering waiting and keeps its start while it waits", () => {
	const idle = makeSession({ status: "idle" });
	const waiting = makeSession({ status: "waiting", waitingSince: 10 });
	expect(waitChange(idle, makeSession({ status: "waiting" }), 10)).toEqual({
		waitingSince: 10,
		ended: null,
	});
	expect(
		waitChange(waiting, makeSession({ status: "waiting", ask: "x" }), 20),
	).toEqual({ waitingSince: 10, ended: null });
});

test("a wait ends when the session moves on, unless it ended unanswered", () => {
	const waiting = makeSession({ status: "waiting", waitingSince: 10 });
	expect(waitChange(waiting, makeSession({ status: "working" }), 70)).toEqual({
		waitingSince: null,
		ended: { repo: "/repos/demo", sessionId: "s1", startedAt: 10, endedAt: 70 },
	});
	for (const status of ["dead", "archived"] as const)
		expect(waitChange(waiting, makeSession({ status }), 70).ended).toBeNull();
	// Waiting since before waits were tracked: no start, so nothing to count.
	expect(
		waitChange(
			makeSession({ status: "waiting" }),
			makeSession({ status: "idle" }),
			70,
		).ended,
	).toBeNull();
});

test("average wait", () => {
	const wait = (startedAt: number, endedAt: number) => ({
		repo: "/r",
		sessionId: "s",
		startedAt,
		endedAt,
	});
	expect(averageWait([])).toBeNull();
	expect(averageWait([wait(0, 10), wait(5, 35)])).toBe(20);
});

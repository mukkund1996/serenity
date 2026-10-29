import { describe, expect, test } from "bun:test";
import type { ReviewRequest } from "@serenity/core";
import {
	type MasterPlanInput,
	needLines,
	planMaster,
	QUEUE_FULL_MAX,
	queueLines,
	queueRows,
	suggestionLines,
	wrappedRows,
} from "../src/master-layout";

const review = (number: number): ReviewRequest => ({
	number,
	url: `u${number}`,
	title: `t${number}`,
	author: "ana",
	updatedAt: 0,
});
/** 1 need item (2 rows), no conversation: 2 + 4 + 1 + 4 + 3 = 14 fixed rows. */
function input(height: number, more: Partial<MasterPlanInput> = {}) {
	return {
		height,
		inner: 60,
		empty: false,
		needs: [{ id: "n1", rows: 2 }],
		selected: null,
		conversation: [],
		slackError: false,
		reviews: [review(1), review(2), review(3)],
		...more,
	};
}

describe("planMaster", () => {
	test("with room for everything, every section shows in full", () => {
		expect(planMaster(input(60)).reviews).toHaveLength(3);
	});

	test("the rows left go to REVIEW, trimmed to fit", () => {
		// 14 fixed; 5 for REVIEW.
		expect(planMaster(input(14 + 5)).reviews).toHaveLength(3);
		expect(planMaster(input(14 + 4)).reviews).toHaveLength(2);
		expect(planMaster(input(14 + 2)).reviews).toHaveLength(0);
	});

	test("NEEDS YOU items are a blank row apart", () => {
		const two = input(14 + 2 + 1 + 5, {
			needs: [
				{ id: "n1", rows: 2 },
				{ id: "n2", rows: 2 },
			],
		});
		// 14 fixed, the second item and its gap; 5 left for REVIEW.
		expect(planMaster(two).reviews).toHaveLength(3);
		expect(planMaster({ ...two, height: two.height - 1 }).reviews).toHaveLength(
			2,
		);
	});

	test("an item's ask and suggestion wrap to two lines instead of being cut", () => {
		const ask =
			"Set the refresh token TTL to 15 minutes or keep it at one hour?";
		expect(needLines(ask, 40)).toHaveLength(2);
		expect(needLines(ask, 40).join(" ")).toBe(ask);
		expect(suggestionLines("Reply ok", 40)).toEqual(["Reply ok"]);
		expect(suggestionLines("", 40)).toEqual([]);
	});

	test("NEEDS YOU and the conversation are never given up", () => {
		const plan = planMaster(
			input(24, {
				needs: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `n${n}`, rows: 3 })),
				selected: "n6",
			}),
		);
		expect(plan.needs).toEqual({ start: 1, count: 5, hidden: 1 });
		expect(plan.reviews).toHaveLength(0);
	});
});

test("wrappedRows wraps on words and breaks words longer than a line", () => {
	expect(wrappedRows("", 10)).toBe(1);
	expect(wrappedRows("aaaa bbbb", 9)).toBe(1);
	expect(wrappedRows("aaaa bbbb", 8)).toBe(2);
	expect(wrappedRows("one\ntwo", 10)).toBe(2);
	expect(wrappedRows("x".repeat(25), 10)).toBe(3);
});

test("a Slack error takes one row under the status line", () => {
	expect(planMaster(input(14 + 5)).reviews).toHaveLength(3);
	expect(planMaster(input(14 + 5, { slackError: true })).reviews).toHaveLength(
		2,
	);
});

test("NEEDS YOU shows before the first session, for Slack's items", () => {
	// 2 + 4 + 3 empty state, 2 + 2 for the one item: 13; 5 for REVIEW.
	const empty = input(13 + 5, { empty: true });
	expect(planMaster(empty).reviews).toHaveLength(3);
	expect(planMaster({ ...empty, height: 13 + 4 }).reviews).toHaveLength(2);
});

describe("the queue", () => {
	const items = (n: number) =>
		Array.from({ length: n }, (_, i) => ({ id: `q${i}`, rows: 1 }));

	test("takes its header and one row per reply, before REVIEW", () => {
		// 14 fixed, the queue's header and 2 rows; 5 left for REVIEW.
		const two = input(14 + 4 + 5, { queue: items(2) });
		expect(planMaster(two).reviews).toHaveLength(3);
		expect(planMaster({ ...two, height: two.height - 1 }).reviews).toHaveLength(
			2,
		);
		expect(planMaster(two).queue).toEqual({ start: 0, count: 2, hidden: 0 });
	});

	test("shows three, the rest as +N more, sliding to the selected reply", () => {
		expect(planMaster(input(60, { queue: items(5) })).queue).toEqual({
			start: 0,
			count: 3,
			hidden: 2,
		});
		expect(
			planMaster(input(60, { queue: items(5), selected: "q4" })).queue,
		).toEqual({ start: 2, count: 3, hidden: 2 });
	});

	test("an expanded reply shows its text in full, line breaks kept", () => {
		const text = "first line\nsecond line that is long enough to wrap twice";
		expect(queueLines(text, 30)).toEqual([
			"first line",
			"second line that is long",
			"enough to wrap twice",
		]);
		expect(queueRows(text, 30, "collapsed")).toBe(1);
		expect(queueRows(text, 30, "expanded")).toBe(4);
		expect(queueRows(text, 30, "editing")).toBe(2);
	});

	test("a very long reply is cut at QUEUE_FULL_MAX lines", () => {
		const lines = queueLines("word ".repeat(400), 30);
		expect(lines).toHaveLength(QUEUE_FULL_MAX);
		expect(lines.at(-1)).toEndWith("…");
	});
});

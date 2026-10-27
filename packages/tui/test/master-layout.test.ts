import { describe, expect, test } from "bun:test";
import type { PrInfo, ReviewRequest, SlackItem } from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import {
	type MasterPlanInput,
	type MyPr,
	needLines,
	planMaster,
	slackRows,
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
const slackItem = (id: string): SlackItem => ({
	id,
	channelId: "C1",
	channel: "#eng",
	author: "ana",
	text: `message ${id}`,
	reason: "mention",
	ts: "1.0",
	threadTs: "1.0",
	permalink: null,
	at: 1000,
});
const mine = (number: number): MyPr => ({
	session: makeSession({ id: `s${number}` }),
	pr: { number, url: `u${number}`, title: `t${number}` } as PrInfo,
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
		slack: null,
		reviews: [review(1), review(2), review(3)],
		mine: [mine(7), mine(6)],
		...more,
	};
}

describe("planMaster", () => {
	test("with room for everything, every section shows in full", () => {
		const plan = planMaster(input(60));
		expect(plan.reviews).toHaveLength(3);
		expect(plan.mine).toHaveLength(2);
	});

	test("the rows left go to REVIEW, then MY PRS", () => {
		// 14 fixed; 5 for REVIEW, 4 for MY PRS.
		let plan = planMaster(input(14 + 5 + 4));
		expect(plan.reviews).toHaveLength(3);
		expect(plan.mine).toHaveLength(2);

		plan = planMaster(input(14 + 5 + 3));
		expect(plan.mine).toHaveLength(1);

		plan = planMaster(input(14 + 4));
		expect(plan.reviews).toHaveLength(2);
		expect(plan.mine).toHaveLength(0);
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
		expect(plan.mine).toHaveLength(0);
	});

	test("empty sections take no rows", () => {
		const plan = planMaster(input(14 + 4 + 3, { reviews: [] }));
		expect(plan.mine).toHaveLength(2);
	});
});

test("wrappedRows wraps on words and breaks words longer than a line", () => {
	expect(wrappedRows("", 10)).toBe(1);
	expect(wrappedRows("aaaa bbbb", 9)).toBe(1);
	expect(wrappedRows("aaaa bbbb", 8)).toBe(2);
	expect(wrappedRows("one\ntwo", 10)).toBe(2);
	expect(wrappedRows("x".repeat(25), 10)).toBe(3);
});

test("Slack takes its rows before REVIEW, whole or not at all", () => {
	const slack = {
		items: [slackItem("a"), slackItem("b")],
		error: null,
		checkedAt: 1,
	};
	const roomy = planMaster(input(60, { slack }));
	expect(roomy.slack).toBe(true);
	expect(roomy.reviews).toHaveLength(3);
	// Its header and three rows exactly fit: REVIEW gets nothing.
	const exact = planMaster(input(14 + 2 + 3, { slack }));
	expect(exact.slack).toBe(true);
	expect(exact.reviews).toHaveLength(0);
	// One row short: Slack is dropped, and REVIEW gets the rows.
	const short = planMaster(input(14 + 2 + 2, { slack }));
	expect(short.slack).toBe(false);
	expect(short.reviews).toHaveLength(2);
});

test("Slack with nothing waiting takes no rows; an error takes one", () => {
	expect(slackRows({ items: [], error: null, checkedAt: 1 })).toBe(0);
	expect(slackRows({ items: [], error: "no login", checkedAt: 1 })).toBe(1);
	expect(slackRows(null)).toBe(0);
});

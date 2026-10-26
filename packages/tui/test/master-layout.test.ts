import { describe, expect, test } from "bun:test";
import type { PrInfo, ReviewRequest } from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import {
	type MasterPlanInput,
	type MyPr,
	planMaster,
	wrappedRows,
} from "../src/master-layout";

const review = (number: number): ReviewRequest => ({
	number,
	url: `u${number}`,
	title: `t${number}`,
	author: "ana",
	updatedAt: 0,
});
const mine = (number: number): MyPr => ({
	session: makeSession({ id: `s${number}` }),
	pr: { number, url: `u${number}`, title: `t${number}` } as PrInfo,
});
const archived = [1, 2, 3, 4, 5].map((n) =>
	makeSession({ id: `a${n}`, status: "archived" }),
);

/** 1 need item (2 rows), no conversation: 2 + 4 + 1 + 4 + 3 = 14 fixed rows. */
function input(height: number, more: Partial<MasterPlanInput> = {}) {
	return {
		height,
		inner: 60,
		empty: false,
		needs: [{ id: "n1", rows: 2 }],
		selected: null,
		conversation: [],
		reviews: [review(1), review(2), review(3)],
		mine: [mine(7), mine(6)],
		archived,
		...more,
	};
}

describe("planMaster", () => {
	test("with room for everything, every section shows in full", () => {
		const plan = planMaster(input(60));
		expect(plan.reviews).toHaveLength(3);
		expect(plan.mine).toHaveLength(2);
		expect(plan.sessions?.archived).toHaveLength(5);
	});

	test("the rows left go to REVIEW, then MY PRS, then SESSIONS", () => {
		// 14 fixed; 5 for REVIEW, 4 for MY PRS, 3 for the counts line.
		let plan = planMaster(input(14 + 5 + 4 + 3 + 3));
		expect(plan.reviews).toHaveLength(3);
		expect(plan.mine).toHaveLength(2);
		expect(plan.sessions?.archived).toEqual(archived.slice(0, 2));

		plan = planMaster(input(14 + 5 + 4 + 2));
		expect(plan.sessions).toBeNull();

		plan = planMaster(input(14 + 5 + 3));
		expect(plan.mine).toHaveLength(1);
		expect(plan.sessions).toBeNull();

		plan = planMaster(input(14 + 4));
		expect(plan.reviews).toHaveLength(2);
		expect(plan.mine).toHaveLength(0);
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
		expect(plan.sessions).toBeNull();
	});

	test("empty sections take no rows", () => {
		const plan = planMaster(input(14 + 4 + 3, { reviews: [] }));
		expect(plan.mine).toHaveLength(2);
		expect(plan.sessions).toEqual({ archived: [] });
	});
});

test("wrappedRows wraps on words and breaks words longer than a line", () => {
	expect(wrappedRows("", 10)).toBe(1);
	expect(wrappedRows("aaaa bbbb", 9)).toBe(1);
	expect(wrappedRows("aaaa bbbb", 8)).toBe(2);
	expect(wrappedRows("one\ntwo", 10)).toBe(2);
	expect(wrappedRows("x".repeat(25), 10)).toBe(3);
});

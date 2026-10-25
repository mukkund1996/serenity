import { describe, expect, test } from "bun:test";
import { groupCategories, needsYou, UNSORTED } from "../src/attention";
import { makeSession } from "../test-support";

describe("needsYou", () => {
	test("orders watched-finished, then waiting, then dead; skips the rest", () => {
		const list = needsYou([
			makeSession({ id: "dead", status: "dead" }),
			makeSession({ id: "work", status: "working" }),
			makeSession({ id: "wait", status: "waiting" }),
			makeSession({ id: "done", status: "done", watched: true }),
			makeSession({ id: "done-unwatched", status: "done" }),
		]);
		expect(list.map((s) => s.id)).toEqual(["done", "wait", "dead"]);
	});
});

describe("groupCategories", () => {
	test("ranks by attention, then name; null category is unsorted", () => {
		const groups = groupCategories([
			makeSession({ id: "1", category: "studio", status: "working" }),
			makeSession({ id: "2", category: "infra", status: "waiting" }),
			makeSession({ id: "3", category: null, status: "dead" }),
			makeSession({ id: "4", category: "backend", status: "idle" }),
		]);
		expect(groups.map((g) => g.name)).toEqual([
			"infra",
			UNSORTED,
			"backend",
			"studio",
		]);
		expect(groups[0]?.counts).toEqual({ waiting: 1, working: 0, done: 0 });
	});
});

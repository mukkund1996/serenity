import { describe, expect, test } from "bun:test";
import { groupTopics, needsYou, UNSORTED } from "../src/attention";
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

describe("groupTopics", () => {
	test("ranks by attention, then name; null topic is unsorted", () => {
		const groups = groupTopics([
			makeSession({ id: "1", topic: "studio", status: "working" }),
			makeSession({ id: "2", topic: "infra", status: "waiting" }),
			makeSession({ id: "3", topic: null, status: "dead" }),
			makeSession({ id: "4", topic: "backend", status: "idle" }),
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

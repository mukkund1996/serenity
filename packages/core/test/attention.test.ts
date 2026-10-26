import { describe, expect, test } from "bun:test";
import {
	archivedTopics,
	groupTopics,
	needsYou,
	PINNED,
	UNSORTED,
} from "../src/attention";
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

	test("an ended pinned session waits to be resumed, not on you", () => {
		const list = needsYou([
			makeSession({ id: "kept", status: "dead", pinned: true }),
		]);
		expect(list).toEqual([]);
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

	test("pinned sessions sit under the pinned topic, always first", () => {
		const groups = groupTopics([
			makeSession({ id: "1", topic: "infra", status: "waiting" }),
			makeSession({ id: "2", topic: "infra", status: "idle", pinned: true }),
			makeSession({ id: "3", topic: null, status: "dead", pinned: true }),
		]);
		expect(groups.map((g) => g.name)).toEqual([PINNED, "infra"]);
		expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["2", "3"]);
		expect(groups[0]?.attention).toBe(0);
	});

	test("leaves archived sessions out; an all-archived topic is gone", () => {
		const groups = groupTopics([
			makeSession({ id: "1", topic: "studio", status: "working" }),
			makeSession({ id: "2", topic: "studio", status: "archived" }),
			makeSession({ id: "3", topic: "infra", status: "archived" }),
		]);
		expect(groups.map((g) => g.name)).toEqual(["studio"]);
		expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["1"]);
	});
});

describe("groupTopics card order", () => {
	test("waiting, then working, then finished, then idle and ended", () => {
		const [group] = groupTopics([
			makeSession({ id: "dead", topic: "x", status: "dead" }),
			makeSession({ id: "done", topic: "x", status: "done" }),
			makeSession({ id: "idle", topic: "x", status: "idle" }),
			makeSession({ id: "work", topic: "x", status: "working" }),
			makeSession({ id: "wait", topic: "x", status: "waiting" }),
		]);
		expect(group?.sessions.map((s) => s.id)).toEqual([
			"wait",
			"work",
			"done",
			"idle",
			"dead",
		]);
	});
});

describe("archivedTopics", () => {
	test("archived sessions only, topics by name, newest first", () => {
		const groups = archivedTopics([
			makeSession({ id: "live", topic: "studio", status: "idle" }),
			makeSession({
				id: "old",
				topic: "studio",
				status: "archived",
				updatedAt: 1,
			}),
			makeSession({
				id: "new",
				topic: "studio",
				status: "archived",
				updatedAt: 2,
			}),
			makeSession({ id: "loose", topic: null, status: "archived" }),
			makeSession({ id: "api", topic: "api", status: "archived" }),
		]);
		expect(groups.map((g) => [g.name, g.sessions.map((s) => s.id)])).toEqual([
			["api", ["api"]],
			["studio", ["new", "old"]],
			[UNSORTED, ["loose"]],
		]);
	});
});

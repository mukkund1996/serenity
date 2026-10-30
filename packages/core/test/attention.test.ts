import { describe, expect, test } from "bun:test";
import {
	actionLine,
	archivedTopics,
	groupTopics,
	isQueued,
	masterQueue,
	needsYou,
	PINNED,
	suggestionAction,
	UNSORTED,
} from "../src/attention";
import { makeSession, makeSuggestion } from "../test-support";

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

	test("a dismissed session stays out until a newer suggestion; a waiting one never leaves", () => {
		const dead = makeSession({ id: "dead", status: "dead", dismissedAt: 10 });
		const wait = makeSession({
			id: "wait",
			status: "waiting",
			dismissedAt: 10,
		});
		expect(needsYou([dead, wait]).map((s) => s.id)).toEqual(["wait"]);
		const old = makeSuggestion({ sessionId: "dead", createdAt: 5 });
		expect(needsYou([dead], [old])).toEqual([]);
		const newer = makeSuggestion({ sessionId: "dead", createdAt: 11 });
		expect(needsYou([dead], [newer]).map((s) => s.id)).toEqual(["dead"]);
		// A queued reply has its own section, so it does not bring it back.
		const queued = makeSuggestion({
			sessionId: "dead",
			source: "chat",
			createdAt: 11,
		});
		expect(needsYou([dead], [queued])).toEqual([]);
	});
});

describe("suggestionAction", () => {
	const session = { name: "api-auth" };
	test("says what y does to which session, and with what", () => {
		const line = (g: Parameters<typeof suggestionAction>[0]) =>
			actionLine(suggestionAction(g, session));
		expect(line({ kind: "reply", label: 'Reply "yes"', text: "yes" })).toBe(
			"Tell api-auth: yes",
		);
		expect(
			line({ kind: "approve", label: "Approve: terraform plan", text: null }),
		).toBe("Approve in api-auth: terraform plan");
		expect(line({ kind: "approve", label: "Approve", text: null })).toBe(
			"Approve in api-auth",
		);
		expect(
			line({ kind: "cleanup", label: "Clean up the worktree", text: null }),
		).toBe("Clean up api-auth: the worktree");
		expect(
			line({
				kind: "review",
				label: "Request review from @alice",
				text: "alice",
			}),
		).toBe("Request review on api-auth: @alice");
	});
});

describe("the master's queue", () => {
	const chat = (id: string, sessionId: string, createdAt: number) =>
		makeSuggestion({ id, sessionId, source: "chat", createdAt });

	test("holds only pending replies the chat drafted", () => {
		expect(isQueued(chat("g", "s1", 1))).toBe(true);
		expect(isQueued(makeSuggestion({ source: "worker" }))).toBe(false);
		expect(isQueued(makeSuggestion({ source: "chat", kind: "approve" }))).toBe(
			false,
		);
		expect(
			isQueued(makeSuggestion({ source: "chat", status: "declined" })),
		).toBe(false);
	});

	test("oldest first, each with its session; one for a session off the map is left out", () => {
		const queue = masterQueue(
			[makeSession({ id: "s1" }), makeSession({ id: "s2" })],
			[chat("late", "s1", 5), chat("early", "s2", 2), chat("gone", "s9", 1)],
		);
		expect(queue.map((q) => [q.suggestion.id, q.session.id])).toEqual([
			["early", "s2"],
			["late", "s1"],
		]);
	});

	test("a queued reply alone puts no session in NEEDS YOU", () => {
		const idle = makeSession({ id: "s1", status: "idle" });
		expect(needsYou([idle], [chat("g", "s1", 1)])).toEqual([]);
		expect(
			needsYou([idle], [makeSuggestion({ sessionId: "s1" })]).map((s) => s.id),
		).toEqual(["s1"]);
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

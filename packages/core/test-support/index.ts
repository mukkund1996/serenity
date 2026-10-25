import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Session, Suggestion } from "../src/domain";
import type { Storage } from "../src/storage";

export function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: "s1",
		repo: "/repos/demo",
		name: "api-auth",
		category: null,
		cwd: "/repos/demo-api-auth",
		worktree: "/repos/demo-api-auth",
		branch: "api-auth",
		ownsBranch: true,
		pr: null,
		prError: null,
		tmuxPane: "%1",
		status: "idle",
		summary: null,
		ask: null,
		waitingOn: null,
		categoryCandidate: null,
		lastPrompt: null,
		lastAssistantMessage: null,
		transcriptPath: null,
		claudeSessionId: null,
		watched: false,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

export function makeSuggestion(
	overrides: Partial<Suggestion> = {},
): Suggestion {
	return {
		id: "g1",
		repo: "/repos/demo",
		sessionId: "s1",
		kind: "reply",
		label: 'Reply "yes"',
		text: "yes",
		status: "pending",
		source: "worker",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

/** The contract every Storage backend must pass (ADR 0009). */
export function storageContract(name: string, open: () => Storage): void {
	describe(`storage contract: ${name}`, () => {
		let storage: Storage;
		beforeEach(() => {
			storage = open();
		});
		afterEach(() => storage.close());

		test("put then get returns an equal copy", () => {
			const s = makeSession({ category: "backend", watched: true });
			storage.sessions.put(s);
			expect(storage.sessions.get("s1")).toEqual(s);
		});

		test("get of a missing id is null", () => {
			expect(storage.sessions.get("nope")).toBeNull();
		});

		test("put replaces the whole session", () => {
			storage.sessions.put(makeSession({ summary: "old" }));
			storage.sessions.put(makeSession({ summary: null, status: "waiting" }));
			expect(storage.sessions.get("s1")).toMatchObject({
				summary: null,
				status: "waiting",
			});
		});

		test("returned sessions are copies", () => {
			storage.sessions.put(makeSession());
			const got = storage.sessions.get("s1") as Session;
			got.name = "mutated";
			expect(storage.sessions.get("s1")?.name).toBe("api-auth");
		});

		test("listByRepo filters by repo and orders by creation", () => {
			storage.sessions.put(makeSession({ id: "b", createdAt: 2 }));
			storage.sessions.put(makeSession({ id: "a", createdAt: 1 }));
			storage.sessions.put(
				makeSession({ id: "c", repo: "/repos/other", createdAt: 0 }),
			);
			expect(
				storage.sessions.listByRepo("/repos/demo").map((s) => s.id),
			).toEqual(["a", "b"]);
			expect(storage.sessions.listAll().map((s) => s.id)).toEqual([
				"c",
				"a",
				"b",
			]);
		});

		test("delete removes a session", () => {
			storage.sessions.put(makeSession());
			storage.sessions.delete("s1");
			expect(storage.sessions.get("s1")).toBeNull();
		});

		test("events append with increasing ids and list newest first", () => {
			const first = storage.events.append({
				sessionId: "s1",
				kind: "SessionStart",
				payload: {},
				at: 1,
			});
			const second = storage.events.append({
				sessionId: "s1",
				kind: "Stop",
				payload: { last_assistant_message: "done" },
				at: 2,
			});
			storage.events.append({
				sessionId: "s2",
				kind: "Stop",
				payload: {},
				at: 3,
			});
			expect(second.id).toBeGreaterThan(first.id);
			const listed = storage.events.listForSession("s1", 10);
			expect(listed.map((e) => e.kind)).toEqual(["Stop", "SessionStart"]);
			expect(listed[0]?.payload).toEqual({ last_assistant_message: "done" });
			expect(storage.events.listForSession("s1", 1)).toHaveLength(1);
		});

		test("transaction commits on success", () => {
			storage.transaction(() => {
				storage.sessions.put(makeSession());
				storage.events.append({
					sessionId: "s1",
					kind: "SessionStart",
					payload: {},
					at: 1,
				});
			});
			expect(storage.sessions.get("s1")).not.toBeNull();
		});

		test("suggestions: put, get, and pending ones per repo in order", () => {
			storage.suggestions.put(makeSuggestion({ id: "b", createdAt: 2 }));
			storage.suggestions.put(makeSuggestion({ id: "a", createdAt: 1 }));
			storage.suggestions.put(makeSuggestion({ id: "c", status: "declined" }));
			storage.suggestions.put(
				makeSuggestion({ id: "d", repo: "/repos/other" }),
			);
			expect(storage.suggestions.get("a")).toEqual(
				makeSuggestion({ id: "a", createdAt: 1 }),
			);
			expect(
				storage.suggestions.listPending("/repos/demo").map((g) => g.id),
			).toEqual(["a", "b"]);
			storage.suggestions.put(
				makeSuggestion({ id: "a", createdAt: 1, status: "accepted" }),
			);
			expect(
				storage.suggestions.listPending("/repos/demo").map((g) => g.id),
			).toEqual(["b"]);
			expect(storage.suggestions.get("nope")).toBeNull();
		});

		test("conversation: append and list the newest messages oldest first", () => {
			for (const [i, text] of ["one", "two", "three"].entries())
				storage.conversation.append({
					repo: "/repos/demo",
					from: i % 2 ? "master" : "you",
					text,
					at: i,
				});
			storage.conversation.append({
				repo: "/repos/other",
				from: "you",
				text: "x",
				at: 9,
			});
			const recent = storage.conversation.listRecent("/repos/demo", 2);
			expect(recent.map((m) => m.text)).toEqual(["two", "three"]);
			expect(recent[0]?.from).toBe("master");
			expect(recent[1]?.id).toBeGreaterThan(recent[0]?.id ?? 0);
		});
	});
}

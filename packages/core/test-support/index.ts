import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Session, Suggestion } from "../src/domain";
import type { Storage } from "../src/storage";

export function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: "s1",
		repo: "/repos/demo",
		name: "api-auth",
		topic: null,
		cwd: "/repos/demo-api-auth",
		worktree: "/repos/demo-api-auth",
		branch: "api-auth",
		ownsBranch: true,
		pr: null,
		prError: null,
		tmuxPane: "%1",
		origin: "spawned",
		tracking: "hooks",
		claudePid: null,
		status: "idle",
		summary: null,
		ask: null,
		waitingOn: null,
		waitingSince: null,
		topicCandidate: null,
		lastPrompt: null,
		lastAssistantMessage: null,
		subagents: [],
		transcriptPath: null,
		claudeSessionId: null,
		watched: false,
		pinned: false,
		exitNote: null,
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
			const s = makeSession({ topic: "backend", watched: true });
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

		test("waits: append and list a repo's waits since a time, oldest first", () => {
			const wait = (
				sessionId: string,
				endedAt: number,
				repo = "/repos/demo",
			) => ({ repo, sessionId, startedAt: endedAt - 5, endedAt });
			storage.waits.append(wait("b", 30));
			storage.waits.append(wait("a", 20));
			storage.waits.append(wait("old", 5));
			storage.waits.append(wait("x", 25, "/repos/other"));
			expect(storage.waits.listSince("/repos/demo", 20)).toEqual([
				wait("a", 20),
				wait("b", 30),
			]);
		});

		test("master: put replaces a repo's record, get and listAll return copies", () => {
			const record = {
				repo: "/repos/demo",
				claudeSessionId: "c1",
				watches: [{ sessionId: "s1", note: "tell me", slack: null }],
				released: ["api is done"],
				outbox: [{ from: "you" as const, text: "hi" }],
			};
			expect(storage.master.get("/repos/demo")).toBeNull();
			storage.master.put(record);
			storage.master.put({ ...record, repo: "/repos/other", outbox: [] });
			const got = storage.master.get("/repos/demo");
			expect(got).toEqual(record);
			got?.outbox.push({ from: "serenity", text: "x" });
			expect(storage.master.get("/repos/demo")).toEqual(record);
			storage.master.put({ ...record, claudeSessionId: null, outbox: [] });
			expect(storage.master.get("/repos/demo")?.claudeSessionId).toBeNull();
			expect(
				storage.master
					.listAll()
					.map((r) => r.repo)
					.sort(),
			).toEqual(["/repos/demo", "/repos/other"]);
		});

		test("slack dismissals: add once per message, list oldest first", () => {
			storage.slackDismissals.add({ channelId: "C1", ts: "2.0", at: 20 });
			storage.slackDismissals.add({ channelId: "C1", ts: "1.0", at: 10 });
			// The same message again keeps the first dismissal.
			storage.slackDismissals.add({ channelId: "C1", ts: "2.0", at: 30 });
			// Same ts in another channel is another message.
			storage.slackDismissals.add({ channelId: "D9", ts: "2.0", at: 40 });
			expect(storage.slackDismissals.list()).toEqual([
				{ channelId: "C1", ts: "1.0", at: 10 },
				{ channelId: "C1", ts: "2.0", at: 20 },
				{ channelId: "D9", ts: "2.0", at: 40 },
			]);
		});

		test("recovery: set, get, replace and remove values by key", () => {
			expect(storage.recovery.get("attached")).toBeNull();
			const attached = [
				{ repo: "/repos/demo", sessionId: "s1", clientPane: "%3" },
			];
			storage.recovery.set("attached", attached);
			storage.recovery.set("offeredReviews", ["s1:4"]);
			expect(storage.recovery.get("attached")).toEqual(attached);
			storage.recovery.set("attached", []);
			expect(storage.recovery.get("attached")).toEqual([]);
			storage.recovery.set("attached", null);
			expect(storage.recovery.get("attached")).toBeNull();
			expect(storage.recovery.get("offeredReviews")).toEqual(["s1:4"]);
		});
	});
}

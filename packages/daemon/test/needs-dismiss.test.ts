/** x on a session in NEEDS YOU (ADR 0057): hidden until something new happens, nothing else. */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createMemoryStorage,
	needsYou,
	type Session,
	type Suggestion,
} from "@serenity/core";
import { makeSession, makeSuggestion } from "@serenity/core/testing";
import { Daemon } from "../src/daemon";

const home = mkdtempSync(join(tmpdir(), "sdismiss-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

type Dismiss = (p: { id: string; mode?: "seen" | "dismiss" }) => null;

function setup(session: Partial<Session>, suggestions: Suggestion[] = []) {
	const storage = createMemoryStorage();
	let t = 100;
	const daemon = new Daemon({ home, storage, log: () => {}, now: () => t });
	const internals = daemon as unknown as {
		handlers: { "session.dismiss": Dismiss };
		change(s: Session, p: Partial<Session>): Session;
	};
	storage.sessions.put(makeSession({ id: "s1", ...session }));
	for (const g of suggestions) storage.suggestions.put(g);
	const get = () => storage.sessions.get("s1") as Session;
	return {
		storage,
		get,
		dismiss: (mode?: "seen" | "dismiss") =>
			internals.handlers["session.dismiss"]({ id: "s1", mode }),
		change: (p: Partial<Session>) => {
			t += 10;
			return internals.change.call(daemon, get(), p);
		},
		shown: () =>
			needsYou([get()], storage.suggestions.listPending(get().repo)).map(
				(s) => s.id,
			),
		tick: (ms: number) => {
			t += ms;
		},
	};
}

test("x on a waiting session hides it, leaves the prompt alone, and a new prompt brings it back", () => {
	const s = setup({
		status: "waiting",
		waitingOn: "permission",
		ask: "wants to run touch x",
	});
	expect(s.shown()).toEqual(["s1"]);
	s.dismiss("dismiss");
	expect(s.shown()).toEqual([]);
	// Still waiting on the same prompt: nothing answered, nothing changed.
	expect(s.get()).toMatchObject({ status: "waiting", waitingOn: "permission" });
	s.change({ summary: "still waiting" });
	expect(s.shown()).toEqual([]);
	s.change({ ask: "wants to run rm y" });
	expect(s.shown()).toEqual(["s1"]);
});

test("Enter (seen) still refuses a waiting session", () => {
	const s = setup({ status: "waiting", waitingOn: "question", ask: "?" });
	expect(() => s.dismiss()).toThrow(/waiting on you/);
	expect(s.shown()).toEqual(["s1"]);
});

test("x on a session with a ◆ suggestion declines it; a newer one brings it back", () => {
	const g = makeSuggestion({ id: "g1", sessionId: "s1", kind: "cleanup" });
	const queued = makeSuggestion({
		id: "q1",
		sessionId: "s1",
		kind: "reply",
		source: "chat",
	});
	const s = setup({ status: "idle" }, [g, queued]);
	expect(s.shown()).toEqual(["s1"]);
	s.dismiss("dismiss");
	expect(s.shown()).toEqual([]);
	expect(s.storage.suggestions.get("g1")?.status).toBe("declined");
	// The queued reply sits in its own section; x on the session leaves it.
	expect(s.storage.suggestions.get("q1")?.status).toBe("pending");
	// Nothing was cleaned up or archived.
	expect(s.get().status).toBe("idle");
	s.tick(10);
	s.storage.suggestions.put(
		makeSuggestion({ id: "g2", sessionId: "s1", createdAt: 1_000 }),
	);
	expect(s.shown()).toEqual(["s1"]);
});

test("x on a watched, finished session keeps its watch; finishing again brings it back", () => {
	const s = setup({ status: "done", watched: true });
	s.dismiss("dismiss");
	expect(s.shown()).toEqual([]);
	expect(s.get().watched).toBe(true);
	s.change({ status: "working" });
	s.change({ status: "done" });
	expect(s.shown()).toEqual(["s1"]);
});

test("x on an ended session hides it; it is not archived", () => {
	const s = setup({ status: "dead" });
	s.dismiss("dismiss");
	expect(s.shown()).toEqual([]);
	expect(s.get().status).toBe("dead");
});

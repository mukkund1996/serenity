import { describe, expect, test } from "bun:test";
import { needsYou } from "../src/attention";
import {
	applySummary,
	chatSnapshot,
	needsSuggestion,
	nextCategory,
	normalizeCategory,
	parseSuggestion,
	parseSummary,
	suggestionPrompt,
	summaryPrompt,
} from "../src/master";
import { makeSession, makeSuggestion } from "../test-support";

describe("categories", () => {
	test("normalize to a short lowercase topic", () => {
		expect(normalizeCategory("  Guide App!! ")).toBe("guide app");
		expect(normalizeCategory("")).toBeNull();
		expect(normalizeCategory(42)).toBeNull();
		expect(normalizeCategory("a".repeat(40))?.length).toBe(20);
	});

	test("are sticky: a change needs the same proposal twice in a row", () => {
		const none = { category: null, categoryCandidate: null };
		expect(nextCategory(none, "backend")).toEqual({
			category: "backend",
			categoryCandidate: null,
		});
		const backend = { category: "backend", categoryCandidate: null };
		expect(nextCategory(backend, "infra")).toEqual({
			category: "backend",
			categoryCandidate: "infra",
		});
		expect(
			nextCategory(
				{ category: "backend", categoryCandidate: "infra" },
				"infra",
			),
		).toEqual({
			category: "infra",
			categoryCandidate: null,
		});
		expect(
			nextCategory(
				{ category: "backend", categoryCandidate: "infra" },
				"backend",
			),
		).toEqual({
			category: "backend",
			categoryCandidate: null,
		});
		expect(nextCategory(backend, null)).toEqual(backend);
	});
});

describe("summaries", () => {
	test("the prompt carries the exchange and existing categories", () => {
		const prompt = summaryPrompt(
			makeSession({
				lastPrompt: "rotate tokens",
				lastAssistantMessage: "Done.",
			}),
			["backend", "infra"],
		);
		expect(prompt).toContain("rotate tokens");
		expect(prompt).toContain("Done.");
		expect(prompt).toContain("backend, infra");
	});

	test("parsing rejects malformed output and clips long text", () => {
		expect(parseSummary(null)).toBeNull();
		expect(parseSummary({ summary: 1, finished: true })).toBeNull();
		const parsed = parseSummary({
			summary: "x".repeat(400),
			ask: "  ",
			finished: true,
			category: "Backend",
		});
		expect(parsed?.summary.length).toBe(160);
		expect(parsed?.ask).toBeNull();
		expect(parsed?.category).toBe("backend");
	});

	test("a question is not finished", () => {
		expect(
			parseSummary({ summary: "s", ask: "15m?", finished: true, category: "x" })
				?.finished,
		).toBe(false);
	});

	test("an ask makes an idle session wait; finished makes it done; busy sessions keep their status", () => {
		const idle = makeSession({ status: "idle" });
		expect(
			applySummary(idle, {
				summary: "s",
				ask: "15m?",
				finished: false,
				category: "auth",
			}),
		).toMatchObject({
			status: "waiting",
			waitingOn: "question",
			ask: "15m?",
			category: "auth",
		});
		expect(
			applySummary(idle, {
				summary: "s",
				ask: null,
				finished: true,
				category: null,
			}),
		).toMatchObject({
			status: "done",
		});
		const working = applySummary(makeSession({ status: "working" }), {
			summary: "s",
			ask: "late?",
			finished: false,
			category: null,
		});
		expect(working.status).toBeUndefined();
		expect(working.summary).toBe("s");
	});
});

describe("suggestions", () => {
	test("are wanted when a session starts to need the user", () => {
		const idle = makeSession({ status: "idle" });
		expect(
			needsSuggestion(idle, makeSession({ status: "waiting", ask: "x" })),
		).toBe(true);
		expect(needsSuggestion(idle, makeSession({ status: "done" }))).toBe(true);
		const waiting = makeSession({ status: "waiting", ask: "x" });
		expect(needsSuggestion(waiting, waiting)).toBe(false);
		expect(
			needsSuggestion(waiting, makeSession({ status: "waiting", ask: "y" })),
		).toBe(true);
		expect(needsSuggestion(idle, makeSession({ status: "working" }))).toBe(
			false,
		);
	});

	test("the prompt only offers kinds that fit the session", () => {
		const permission = suggestionPrompt(
			makeSession({ status: "waiting", waitingOn: "permission" }),
		);
		expect(permission).toContain("- approve:");
		expect(permission).not.toContain("- reply:");
		const done = suggestionPrompt(makeSession({ status: "done" }));
		expect(done).toContain("- cleanup:");
		expect(done).not.toContain("- approve:");
	});

	test("parsing enforces kinds against the session", () => {
		const permission = makeSession({
			status: "waiting",
			waitingOn: "permission",
		});
		const question = makeSession({ status: "waiting", waitingOn: "question" });
		const done = makeSession({ status: "done" });
		expect(
			parseSuggestion(
				{ kind: "approve", label: "Approve", text: null },
				permission,
			)?.kind,
		).toBe("approve");
		expect(
			parseSuggestion(
				{ kind: "approve", label: "Approve", text: null },
				question,
			),
		).toBeNull();
		expect(
			parseSuggestion(
				{ kind: "reply", label: 'Reply "yes"', text: "yes" },
				question,
			),
		).toEqual({
			kind: "reply",
			label: 'Reply "yes"',
			text: "yes",
		});
		expect(
			parseSuggestion({ kind: "reply", label: "Reply", text: "" }, question),
		).toBeNull();
		expect(
			parseSuggestion({ kind: "cleanup", label: "Clean up", text: null }, done)
				?.kind,
		).toBe("cleanup");
		expect(
			parseSuggestion(
				{ kind: "cleanup", label: "Clean up", text: null },
				question,
			),
		).toBeNull();
		expect(
			parseSuggestion({ kind: "none", label: "x", text: null }, done),
		).toBeNull();
	});
});

test("the chat snapshot lists every session with what it needs", () => {
	const a = makeSession({
		id: "a",
		name: "api-auth",
		category: "backend",
		status: "waiting",
		waitingOn: "question",
		ask: "15m?",
	});
	const b = makeSession({
		id: "b",
		name: "docs",
		status: "working",
		lastPrompt: "write docs",
	});
	const text = chatSnapshot(
		[a, b],
		[makeSuggestion({ sessionId: "a", label: 'Reply "yes"' })],
	);
	expect(text).toContain(
		'- api-auth [backend] waiting on question · asks: 15m? · pending suggestion: Reply "yes"',
	);
	expect(text).toContain("- docs [unsorted] working · last prompt: write docs");
	expect(chatSnapshot([], [])).toBe("Sessions: none yet.");
});

test("needsYou includes sessions with a pending suggestion, last", () => {
	const waiting = makeSession({ id: "w", status: "waiting" });
	const done = makeSession({ id: "d", status: "done" });
	expect(needsYou([done, waiting]).map((s) => s.id)).toEqual(["w"]);
	expect(
		needsYou([done, waiting], [makeSuggestion({ sessionId: "d" })]).map(
			(s) => s.id,
		),
	).toEqual(["w", "d"]);
});

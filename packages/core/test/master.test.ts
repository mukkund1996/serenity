import { describe, expect, test } from "bun:test";
import { needsYou } from "../src/attention";
import {
	applySummary,
	capTopic,
	chatSnapshot,
	needsSuggestion,
	nextTopic,
	normalizeTopic,
	parseSuggestion,
	parseSummary,
	suggestionPrompt,
	summaryPrompt,
	summarySchema,
} from "../src/master";
import { makeSession, makeSuggestion } from "../test-support";

describe("topics", () => {
	test("normalize to a short lowercase topic", () => {
		expect(normalizeTopic("  Guide App!! ")).toBe("guide app");
		expect(normalizeTopic("")).toBeNull();
		expect(normalizeTopic(42)).toBeNull();
		expect(normalizeTopic("a".repeat(40))?.length).toBe(20);
	});

	test("are sticky: a change needs the same proposal twice in a row", () => {
		const none = { topic: null, topicCandidate: null };
		expect(nextTopic(none, "backend")).toEqual({
			topic: "backend",
			topicCandidate: null,
		});
		const backend = { topic: "backend", topicCandidate: null };
		expect(nextTopic(backend, "infra")).toEqual({
			topic: "backend",
			topicCandidate: "infra",
		});
		expect(
			nextTopic({ topic: "backend", topicCandidate: "infra" }, "infra"),
		).toEqual({
			topic: "infra",
			topicCandidate: null,
		});
		expect(
			nextTopic({ topic: "backend", topicCandidate: "infra" }, "backend"),
		).toEqual({
			topic: "backend",
			topicCandidate: null,
		});
		expect(nextTopic(backend, null)).toEqual(backend);
	});
});

describe("summaries", () => {
	test("the prompt carries the exchange and existing topics", () => {
		const prompt = summaryPrompt(
			makeSession({
				lastPrompt: "rotate tokens",
				lastAssistantMessage: "Done.",
			}),
			["backend", "infra"],
			10,
		);
		expect(prompt).toContain("rotate tokens");
		expect(prompt).toContain("Done.");
		expect(prompt).toContain("backend, infra");
		expect(prompt).toContain("Strongly prefer an existing topic");
	});

	test("the topic cap: reuse below it is free, a new topic past it is dropped", () => {
		const topics = ["backend", "infra"];
		expect(capTopic("web", topics, 3)).toBe("web");
		expect(capTopic("web", topics, 2)).toBeNull();
		expect(capTopic("infra", topics, 2)).toBe("infra");
		expect(summarySchema(topics, 3).properties.topic).toEqual({
			type: "string",
		});
		expect(summarySchema(topics, 2).properties.topic).toEqual({
			type: "string",
			enum: topics,
		});
	});

	test("parsing rejects malformed output and clips long text", () => {
		expect(parseSummary(null)).toBeNull();
		expect(parseSummary({ summary: 1, finished: true })).toBeNull();
		const parsed = parseSummary({
			summary: "x".repeat(400),
			ask: "  ",
			finished: true,
			topic: "Backend",
		});
		expect(parsed?.summary.length).toBe(160);
		expect(parsed?.ask).toBeNull();
		expect(parsed?.topic).toBe("backend");
	});

	test("a question is not finished", () => {
		expect(
			parseSummary({ summary: "s", ask: "15m?", finished: true, topic: "x" })
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
				topic: "auth",
			}),
		).toMatchObject({
			status: "waiting",
			waitingOn: "question",
			ask: "15m?",
			topic: "auth",
		});
		expect(
			applySummary(idle, {
				summary: "s",
				ask: null,
				finished: true,
				topic: null,
			}),
		).toMatchObject({
			status: "done",
		});
		const working = applySummary(makeSession({ status: "working" }), {
			summary: "s",
			ask: "late?",
			finished: false,
			topic: null,
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
		topic: "backend",
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
	const withPr = chatSnapshot(
		[
			makeSession({
				name: "pr",
				pr: {
					number: 7,
					url: "u",
					title: "t",
					state: "MERGED",
					isDraft: false,
					checks: "passing",
					reviewDecision: null,
					reviewRequests: [],
					reviewed: false,
					author: null,
					headRefOid: "x",
					baseRefName: "main",
					files: [],
				},
			}),
		],
		[],
	);
	expect(withPr).toContain("PR #7 merged");
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

test("a done session whose PR merges asks for a suggestion again", () => {
	const pr = {
		number: 1,
		url: "u",
		title: "t",
		state: "OPEN" as const,
		isDraft: false,
		checks: "passing" as const,
		reviewDecision: null,
		reviewRequests: [],
		reviewed: false,
		author: null,
		headRefOid: "x",
		baseRefName: "main",
		files: [],
	};
	const doneOpen = makeSession({ status: "done", pr });
	const merged = makeSession({
		status: "done",
		pr: { ...pr, state: "MERGED" },
	});
	expect(needsSuggestion(doneOpen, merged)).toBe(true);
	expect(needsSuggestion(merged, merged)).toBe(false);
	expect(
		parseSuggestion(
			{ kind: "cleanup", label: "Clean up", text: null },
			doneOpen,
		),
	).toBeNull();
	expect(
		parseSuggestion({ kind: "cleanup", label: "Clean up", text: null }, merged)
			?.kind,
	).toBe("cleanup");
});

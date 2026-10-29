import { describe, expect, test } from "bun:test";
import { needsYou } from "../src/attention";
import {
	applySummary,
	capTopic,
	chatSnapshot,
	heldTopic,
	MASTER_SLACK_PROMPT,
	MASTER_SYSTEM_PROMPT,
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

	test("a move is held while it works or the user types, then counts as its topic", () => {
		const backend = { topic: "backend", topicCandidate: null, topicHeld: null };
		// The first proposal only becomes a candidate, held or not.
		expect(heldTopic(backend, "infra", true)).toEqual({
			topic: "backend",
			topicCandidate: "infra",
			topicHeld: null,
		});
		const settled = { ...backend, topicCandidate: "infra" };
		expect(heldTopic(settled, "infra", false)).toEqual({
			topic: "infra",
			topicCandidate: null,
			topicHeld: null,
		});
		const held = heldTopic(settled, "infra", true);
		expect(held).toEqual({
			topic: "backend",
			topicCandidate: null,
			topicHeld: "infra",
		});
		// Proposed again while held, it stays held; it needs no new candidate.
		expect(heldTopic(held, "infra", true)).toEqual(held);
		expect(heldTopic(held, null, true)).toEqual(held);
		// Back to where it is: nothing is held any more.
		expect(
			heldTopic({ ...held, topicCandidate: "backend" }, "backend", true),
		).toEqual(backend);
		// A session with no topic yet waits for its first one too.
		expect(
			heldTopic(
				{ topic: null, topicCandidate: null, topicHeld: null },
				"web",
				true,
			),
		).toEqual({ topic: null, topicCandidate: null, topicHeld: "web" });
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
	});

	test("the prompt asks for a narrow topic and a new one for distinct work", () => {
		const prompt = summaryPrompt(makeSession(), ["backend", "infra"], 10);
		expect(prompt).toContain("feature or area of the code");
		expect(prompt).toContain("not a broad theme");
		expect(prompt).toContain(
			"create a new topic instead of stretching a broad one",
		);
		expect(prompt).toContain("Never create a variant of an existing topic");
		expect(prompt).toContain("8 new topics are left.");
		expect(prompt).not.toContain("Strongly prefer");
		expect(summaryPrompt(makeSession(), ["a", "b"], 3)).toContain(
			"1 new topic is left, so keep them for clearly distinct work.",
		);
	});

	test("a near-duplicate topic name joins the existing topic", () => {
		const topics = ["master agent", "pr-status", "slack"];
		expect(capTopic("master agents", topics, 10)).toBe("master agent");
		expect(capTopic("agent master", topics, 10)).toBe("master agent");
		expect(capTopic("pr status", topics, 10)).toBe("pr-status");
		expect(capTopic("slacks", topics, 10)).toBe("slack");
		// A word ending in "ss" is not a plural.
		expect(capTopic("access", ["acces"], 10)).toBe("access");
		// At the cap, a near-duplicate still lands in its topic.
		expect(capTopic("master agents", topics, 3)).toBe("master agent");
		expect(capTopic("master chat", topics, 10)).toBe("master chat");
	});

	test("the topic cap: reuse below it is free, a new topic past it is dropped", () => {
		const topics = ["backend", "infra"];
		expect(capTopic("web", topics, 3)).toBe("web");
		expect(capTopic("web", topics, 2)).toBeNull();
		expect(capTopic("infra", topics, 2)).toBe("infra");
		// Only the user's pin puts a session there.
		expect(capTopic("pinned", topics, 3)).toBeNull();
		expect(summarySchema(topics, 3).properties.topic).toMatchObject({
			type: "string",
		});
		expect(summarySchema(topics, 3).properties.topic).not.toHaveProperty(
			"enum",
		);
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
		expect(parsed?.summary.length).toBe(130);
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
		const pinned = applySummary(
			makeSession({ status: "idle", topic: "auth", pinned: true }),
			{ summary: "s", ask: null, finished: true, topic: "infra" },
		);
		expect(pinned).toEqual({ summary: "s" });
		const working = applySummary(makeSession({ status: "working" }), {
			summary: "s",
			ask: "late?",
			finished: false,
			topic: null,
		});
		expect(working.status).toBeUndefined();
		expect(working.summary).toBe("s");
	});

	test("a topic move waits while the session works or the user types", () => {
		const result = { summary: "s", ask: null, finished: false, topic: "infra" };
		const settled = { topic: "backend", topicCandidate: "infra" };
		expect(
			applySummary(makeSession({ ...settled, status: "working" }), result),
		).toMatchObject({ topic: "backend", topicHeld: "infra" });
		expect(
			applySummary(makeSession({ ...settled, status: "idle" }), result, true),
		).toMatchObject({ topic: "backend", topicHeld: "infra" });
		for (const status of ["idle", "waiting", "done"] as const)
			expect(
				applySummary(makeSession({ ...settled, status }), result),
			).toMatchObject({ topic: "infra", topicHeld: null });
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
		const pinned = makeSession({ status: "done", pinned: true });
		expect(suggestionPrompt(pinned)).not.toContain("- cleanup:");
		expect(
			parseSuggestion(
				{ kind: "cleanup", label: "Clean up", text: null },
				pinned,
			),
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

describe("the chat's prompts", () => {
	test("tell the master an @-mentioned session is relayed to at once", () => {
		expect(MASTER_SYSTEM_PROMPT).toContain("@-mentions a session");
		expect(MASTER_SYSTEM_PROMPT).toContain("no draft and no confirmation");
	});

	test("tell the master never to look into an @-mentioned session itself", () => {
		expect(MASTER_SYSTEM_PROMPT).toContain(
			"Never look into a mentioned session yourself",
		);
		expect(MASTER_SLACK_PROMPT).toContain(
			"unless the message @-mentions a session",
		);
	});
});

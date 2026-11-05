import { describe, expect, test } from "bun:test";
import {
	CHILDREN_MAX,
	childReport,
	FANOUT_MAX,
	fanoutLabel,
	fanoutProblem,
	groupTopics,
	parseFanoutSessions,
	preferFanout,
	userAskedForSessions,
	withChildrenUnderParents,
} from "../src";
import { makeSession, makeSuggestion } from "../test-support";

const PROMPT =
	"Add rate limiting to the login endpoint in api/auth.ts, with tests; open a PR.";

describe("parseFanoutSessions", () => {
	test("takes names and prompts", () => {
		expect(
			parseFanoutSessions([
				{ name: " api ", prompt: PROMPT },
				{ name: "ui", prompt: PROMPT },
			]),
		).toEqual([
			{ name: "api", prompt: PROMPT },
			{ name: "ui", prompt: PROMPT },
		]);
	});

	test("refuses an empty list, too many, duplicates and short prompts", () => {
		expect(parseFanoutSessions([])).toBeString();
		expect(parseFanoutSessions("x")).toBeString();
		const many = Array.from({ length: FANOUT_MAX + 1 }, (_, i) => ({
			name: `s${i}`,
			prompt: PROMPT,
		}));
		expect(parseFanoutSessions(many)).toContain(`At most ${FANOUT_MAX}`);
		expect(
			parseFanoutSessions([
				{ name: "a", prompt: PROMPT },
				{ name: "A", prompt: PROMPT },
			]),
		).toContain("twice");
		expect(parseFanoutSessions([{ name: "a", prompt: "do it" }])).toContain(
			"too short",
		);
		expect(parseFanoutSessions([{ prompt: PROMPT }])).toContain("name");
	});
});

describe("fanoutProblem", () => {
	const parent = makeSession({ id: "p", name: "lead" });

	test("a top-level live session may fan out", () => {
		expect(fanoutProblem(parent, 3, [parent])).toBeNull();
	});

	test("a child cannot fan out again", () => {
		const child = makeSession({ id: "c", parentId: "p" });
		expect(fanoutProblem(child, 1, [parent, child])).toContain(
			"cannot fan out itself",
		);
	});

	test("an ended parent cannot", () => {
		expect(fanoutProblem({ ...parent, status: "dead" }, 1, [])).toContain(
			"ended",
		);
	});

	test("live children count toward the cap; ended ones do not", () => {
		const kids = Array.from({ length: CHILDREN_MAX - 1 }, (_, i) =>
			makeSession({ id: `c${i}`, parentId: "p" }),
		);
		const gone = makeSession({ id: "g", parentId: "p", status: "archived" });
		const all = [parent, ...kids, gone];
		expect(fanoutProblem(parent, 1, all)).toBeNull();
		expect(fanoutProblem(parent, 2, all)).toContain(`at most ${CHILDREN_MAX}`);
	});
});

test("userAskedForSessions reads the user's own words", () => {
	expect(userAskedForSessions("split this into 3 sessions")).toBe(true);
	expect(userAskedForSessions("fan out the refactor")).toBe(true);
	expect(userAskedForSessions("do these in parallel")).toBe(true);
	expect(userAskedForSessions("fix the login bug")).toBe(false);
	expect(userAskedForSessions(null)).toBe(false);
});

test("fanoutLabel names the sessions", () => {
	expect(
		fanoutLabel([
			{ name: "a", prompt: PROMPT },
			{ name: "b", prompt: PROMPT },
		]),
	).toBe("Start 2 sessions: a, b");
	expect(fanoutLabel([{ name: "a", prompt: PROMPT }])).toBe(
		"Start 1 session: a",
	);
});

describe("childReport", () => {
	const working = makeSession({ name: "kid", status: "working" });

	test("a finished turn carries the reply", () => {
		expect(
			childReport(working, {
				...working,
				status: "idle",
				lastAssistantMessage: "Opened PR #4",
			}),
		).toBe("kid finished its turn: Opened PR #4");
	});

	test("a question carries the ask", () => {
		expect(
			childReport(working, {
				...working,
				status: "waiting",
				waitingOn: "question",
				ask: "Which DB?",
			}),
		).toBe("kid asks: Which DB?");
	});

	test("a permission prompt is the user's, not reported", () => {
		expect(
			childReport(working, {
				...working,
				status: "waiting",
				waitingOn: "permission",
			}),
		).toBeNull();
	});

	test("an end is reported; other changes are not", () => {
		expect(childReport(working, { ...working, status: "dead" })).toBe(
			"kid has ended",
		);
		const idle = { ...working, status: "idle" as const };
		expect(childReport(idle, { ...idle, status: "done" })).toBeNull();
		expect(childReport(idle, { ...idle, status: "working" })).toBeNull();
	});
});

test("children are drawn right after their parent", () => {
	const a = makeSession({ id: "a", name: "a" });
	const kid = makeSession({ id: "k", name: "k", parentId: "b" });
	const b = makeSession({ id: "b", name: "b" });
	const orphan = makeSession({ id: "o", name: "o", parentId: "gone" });
	expect(
		withChildrenUnderParents([kid, a, orphan, b]).map((s) => s.id),
	).toEqual(["a", "o", "b", "k"]);
});

test("groupTopics keeps a child under its parent whatever its status", () => {
	const parent = makeSession({ id: "p", name: "lead", topic: "api" });
	const kid = makeSession({
		id: "k",
		name: "kid",
		topic: "api",
		parentId: "p",
		status: "waiting",
	});
	const other = makeSession({ id: "o", name: "other", topic: "api" });
	const [group] = groupTopics([parent, kid, other]);
	expect(group?.sessions.map((s) => s.id)).toEqual(["p", "k", "o"]);
});

test("preferFanout puts a session's fanout request before its other suggestions", () => {
	const reply = makeSuggestion({ id: "r", kind: "reply" });
	const fan = makeSuggestion({ id: "f", kind: "fanout" });
	expect(preferFanout([reply, fan])?.id).toBe("f");
	expect(preferFanout([reply])?.id).toBe("r");
	expect(preferFanout([])).toBeUndefined();
});

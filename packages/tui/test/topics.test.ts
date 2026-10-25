import { describe, expect, test } from "bun:test";
import { groupCategories } from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import { splitAtNewline } from "../src/text-input";
import { drawTopics, moveFocus } from "../src/topics";

const sessions = [
	makeSession({
		id: "a1",
		name: "api-auth",
		category: "backend",
		status: "waiting",
		ask: "set TTL to 15m?",
	}),
	makeSession({
		id: "a2",
		name: "sync-worker",
		category: "backend",
		status: "working",
	}),
	makeSession({
		id: "i1",
		name: "tf-staging",
		category: "infra",
		status: "dead",
	}),
	...["c1", "c2", "c3", "c4"].map((id) =>
		makeSession({ id, name: `ci-${id}`, category: "infra" }),
	),
	makeSession({ id: "d1", name: "pricing", category: "discovery" }),
];

function draw(focusId: string | null = null, width = 140) {
	return drawTopics({
		width,
		height: 46,
		masterRow: 23,
		groups: groupCategories(sessions),
		focusId,
		replyText: null,
	});
}

describe("drawTopics", () => {
	test("shows the two neediest categories, three cards each, the rest in the node", () => {
		const { canvas, cards } = draw();
		const text = canvas.toString();
		expect(text).toContain("backend · ◐1 ●1");
		expect(text).toContain("infra · quiet");
		expect(text).toContain("+2 more");
		expect(text).toContain("1 more category");
		expect(text).toContain("discovery");
		expect(cards.map((c) => c.sessionId)).toEqual([
			"a1",
			"a2",
			"i1",
			"c1",
			"c2",
		]);
	});

	test("waiting cards carry the WAITING chip and their ask", () => {
		const text = draw().canvas.toString();
		expect(text).toContain("◐ api-auth");
		expect(text).toContain("WAITING");
		expect(text).toContain("set TTL to 15m?");
	});

	test("links run from the master row to every bubble", () => {
		const rows = draw().canvas.toString().split("\n");
		expect(rows[23]?.startsWith("──")).toBe(true);
		expect(rows.filter((r) => r.includes("●")).length).toBeGreaterThanOrEqual(
			3,
		);
	});

	test("the focused card is heavy and taller", () => {
		const { canvas, cards } = draw("a2");
		expect(cards.find((c) => c.sessionId === "a2")?.h).toBe(6);
		expect(canvas.toString()).toContain("┏ ● sync-worker");
	});

	test("a card shows the latest exchange in order: prompt, then reply", () => {
		const groups = groupCategories([
			makeSession({
				id: "x",
				status: "idle",
				lastPrompt: "who are you?",
				lastAssistantMessage: "I'm Claude.",
			}),
		]);
		const rows = drawTopics({
			width: 60,
			height: 12,
			masterRow: 6,
			groups,
			focusId: null,
			replyText: null,
		})
			.canvas.toString()
			.split("\n");
		const you = rows.findIndex((r) => r.includes('you › "who are you?"'));
		const claude = rows.findIndex((r) => r.includes("claude › I'm Claude."));
		expect(you).toBeGreaterThan(-1);
		expect(claude).toBe(you + 1);
	});

	test("while working, the reply row says so instead of an older answer", () => {
		const groups = groupCategories([
			makeSession({
				id: "x",
				status: "working",
				lastPrompt: "go",
				lastAssistantMessage: null,
			}),
		]);
		const text = drawTopics({
			width: 60,
			height: 12,
			masterRow: 6,
			groups,
			focusId: null,
			replyText: null,
		}).canvas.toString();
		expect(text).toContain("working…");
	});

	test("cards sit side by side when there is room", () => {
		const { cards } = draw(null, 160);
		const infra = cards.filter((c) => ["i1", "c1", "c2"].includes(c.sessionId));
		expect(new Set(infra.map((c) => c.y)).size).toBe(1);
	});

	test("nothing to draw without sessions", () => {
		const layout = drawTopics({
			width: 60,
			height: 10,
			masterRow: 5,
			groups: [],
			focusId: null,
			replyText: null,
		});
		expect(layout.cards).toEqual([]);
		expect(layout.canvas.toString().trim()).toBe("");
	});
});

describe("moveFocus", () => {
	const cards = [
		{ sessionId: "top", x: 0, y: 0, w: 40, h: 5 },
		{ sessionId: "right", x: 42, y: 0, w: 40, h: 5 },
		{ sessionId: "below", x: 0, y: 8, w: 40, h: 5 },
	];
	test("moves to the nearest card in a direction and stays put at an edge", () => {
		expect(moveFocus(cards, "top", "right")).toBe("right");
		expect(moveFocus(cards, "top", "down")).toBe("below");
		expect(moveFocus(cards, "below", "up")).toBe("top");
		expect(moveFocus(cards, "top", "up")).toBe("top");
		expect(moveFocus(cards, null, "down")).toBe("top");
	});
});

test("splitAtNewline treats a trailing return as submit", () => {
	expect(splitAtNewline("hello\r")).toEqual({ text: "hello", submit: true });
	expect(splitAtNewline("hel")).toEqual({ text: "hel", submit: false });
});

test("card row 1 shows the PR and its status word, or why it is unknown", () => {
	const pr = {
		number: 482,
		url: "u",
		title: "t",
		state: "OPEN" as const,
		isDraft: false,
		checks: "failing" as const,
		reviewDecision: null,
		reviewRequests: [],
		reviewed: false,
		author: null,
		headRefOid: "x",
		baseRefName: "main",
		files: [],
	};
	const text = drawTopics({
		width: 140,
		height: 30,
		masterRow: 15,
		groups: groupCategories([
			makeSession({ id: "a", name: "a", pr }),
			makeSession({ id: "b", name: "b", prError: "gh not logged in" }),
			makeSession({ id: "c", name: "c" }),
		]),
		focusId: null,
		replyText: null,
	}).canvas.toString();
	expect(text).toContain("PR #482 checks failing");
	expect(text).toContain("PR unknown · gh not logged in");
	expect(text).toContain("no PR yet");
});

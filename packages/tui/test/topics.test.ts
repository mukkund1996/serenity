import { describe, expect, test } from "bun:test";
import { groupTopics } from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import { splitAtNewline } from "../src/text-input";
import { drawTopics, holdOrder, moveFocus, stepTopic } from "../src/topics";

const sessions = [
	makeSession({
		id: "a1",
		name: "api-auth",
		topic: "backend",
		status: "waiting",
		ask: "set TTL to 15m?",
	}),
	makeSession({
		id: "a2",
		name: "sync-worker",
		topic: "backend",
		status: "working",
	}),
	makeSession({
		id: "i1",
		name: "tf-staging",
		topic: "infra",
		status: "dead",
	}),
	...["c1", "c2", "c3", "c4"].map((id) =>
		makeSession({ id, name: `ci-${id}`, topic: "infra" }),
	),
	makeSession({ id: "d1", name: "pricing", topic: "discovery" }),
];

function draw(focusId: string | null = null, width = 140) {
	return drawTopics({
		width,
		height: 46,
		masterRow: 23,
		groups: groupTopics(sessions),
		focusId,
		replyText: null,
	});
}

describe("drawTopics", () => {
	test("shows every topic and every card, neediest first", () => {
		const { canvas, cards } = draw();
		const text = canvas.toString();
		expect(text).toContain("backend · ◐1 ●1");
		expect(text).toContain("infra · quiet");
		expect(text).toContain("discovery · quiet");
		expect(text).not.toContain("more");
		expect(cards.map((c) => c.sessionId)).toEqual([
			"a1",
			"a2",
			"c1",
			"c2",
			"c3",
			"c4",
			"i1",
			"d1",
		]);
	});

	test("a stack taller than the canvas scrolls to the focused card", () => {
		const layout = (focusId: string) =>
			drawTopics({
				width: 60,
				height: 20,
				masterRow: 10,
				groups: groupTopics(sessions),
				focusId,
				replyText: null,
			});
		const top = layout("a1");
		expect(top.canvas.toString()).toContain("◐ api-auth");
		expect(top.canvas.toString()).toContain("▼");

		const bottom = layout("d1");
		const text = bottom.canvas.toString();
		expect(text).toContain("pricing");
		expect(text).not.toContain("api-auth");
		expect(text).toContain("▲");
		const d1 = bottom.cards.find((c) => c.sessionId === "d1");
		expect(d1?.y).toBeGreaterThanOrEqual(0);
		expect((d1?.y ?? 0) + (d1?.h ?? 0)).toBeLessThanOrEqual(20);
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
		const groups = groupTopics([
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
		const groups = groupTopics([
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
		const infra = cards.filter((c) => ["c1", "c2", "c3"].includes(c.sessionId));
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
		{ id: "top", x: 0, y: 0, w: 40, h: 5 },
		{ id: "right", x: 42, y: 0, w: 40, h: 5 },
		{ id: "below", x: 0, y: 8, w: 40, h: 5 },
	];
	test("moves to the nearest card in a direction and stays put at an edge", () => {
		expect(moveFocus(cards, "top", "right")).toBe("right");
		expect(moveFocus(cards, "top", "down")).toBe("below");
		expect(moveFocus(cards, "below", "up")).toBe("top");
		expect(moveFocus(cards, "top", "up")).toBe("top");
		expect(moveFocus(cards, null, "down")).toBe("top");
	});

	test("the master is reached with A from the left column and left with D", () => {
		const nodes = [{ id: "master", x: -40, y: 0, w: 40, h: 20 }, ...cards];
		expect(moveFocus(nodes, "below", "left")).toBe("master");
		expect(moveFocus(nodes, "right", "left")).toBe("top");
		// D from the master picks the card nearest its centre row.
		expect(moveFocus(nodes, "master", "right")).toBe("below");
		expect(moveFocus(nodes, "master", "up")).toBe("master");
		expect(moveFocus(nodes, "master", "down")).toBe("master");
		expect(moveFocus(nodes, "top", "up")).toBe("top");
	});
});

describe("focused card elements", () => {
	const groups = groupTopics([
		makeSession({ id: "x", name: "api-auth", status: "waiting", ask: "ok?" }),
	]);
	const drawFocused = (
		focusElement: "card" | "pr" | "suggestion" | "reply",
		focusSuggestion: string | null,
	) =>
		drawTopics({
			width: 60,
			height: 16,
			masterRow: 8,
			groups,
			focusId: "x",
			focusElement,
			focusSuggestion,
			replyText: null,
		});

	test("the master's suggestion gets its own row above the input", () => {
		const { canvas, cards } = drawFocused("card", 'Reply "ok"');
		expect(cards[0]?.h).toBe(7);
		const rows = canvas.toString().split("\n");
		const pick = rows.findIndex((r) => r.includes('◆ Reply "ok"'));
		expect(pick).toBeGreaterThan(-1);
		expect(rows[pick]).toContain("y e n");
		expect(rows[pick + 1]).toContain("›");
	});

	test("the selected element carries the ▸ cursor; the card itself has none", () => {
		expect(drawFocused("card", null).canvas.toString()).not.toContain("▸");
		const pr = drawFocused("pr", null).canvas.toString().split("\n");
		expect(pr.find((r) => r.includes("▸"))).toContain("no PR yet");
		const reply = drawFocused("reply", null).canvas.toString().split("\n");
		expect(reply.find((r) => r.includes("▸"))).toContain("┃▸›");
	});
});

describe("stepTopic", () => {
	const groups = groupTopics(sessions);
	test("jumps to the first card of the next or previous topic, wrapping", () => {
		expect(groups.map((g) => g.name)).toEqual([
			"backend",
			"infra",
			"discovery",
		]);
		expect(stepTopic(groups, "a2", 1)).toBe("c1");
		expect(stepTopic(groups, "c3", 1)).toBe("d1");
		expect(stepTopic(groups, "d1", 1)).toBe("a1");
		expect(stepTopic(groups, "a1", -1)).toBe("d1");
		expect(stepTopic(groups, null, 1)).toBe("a1");
		expect(stepTopic([], null, 1)).toBeNull();
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
		groups: groupTopics([
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

describe("holdOrder", () => {
	const groups = groupTopics([
		makeSession({ id: "w", topic: "x", status: "waiting" }),
		makeSession({ id: "d", topic: "x", status: "done" }),
		makeSession({ id: "n", topic: "x", status: "working" }),
		makeSession({ id: "y", topic: "y", status: "done" }),
		makeSession({ id: "z", topic: "y", status: "waiting" }),
	]);
	const drawn = new Map([
		["x", ["d", "w"]],
		["y", ["y", "z"]],
	]);

	test("the focused topic keeps its drawn order; new cards join at the end", () => {
		const held = holdOrder(groups, drawn, "x");
		expect(held.find((g) => g.name === "x")?.sessions.map((s) => s.id)).toEqual(
			["d", "w", "n"],
		);
		expect(held.find((g) => g.name === "y")?.sessions.map((s) => s.id)).toEqual(
			["z", "y"],
		);
	});

	test("with nothing focused every topic takes its fresh order", () => {
		expect(holdOrder(groups, drawn, null)).toBe(groups);
	});
});

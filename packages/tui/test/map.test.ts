import { describe, expect, test } from "bun:test";
import { groupTopics, type Session } from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import { drawMap, type MapMaster, visibleRows } from "../src/map";
import { fieldAt } from "../src/text-input";
import { moveFocus } from "../src/topics";
import { withCursor } from "./cursor";

const sessions = [
	makeSession({
		id: "a1",
		name: "api-auth",
		topic: "backend",
		status: "waiting",
		ask: "set TTL to 15m?",
		watched: true,
	}),
	makeSession({
		id: "a2",
		name: "sync-worker",
		topic: "backend",
		status: "working",
	}),
	...["c1", "c2", "c3", "c4", "c5", "c6", "c7"].map((id) =>
		makeSession({ id, name: `ci-${id}`, topic: "infra" }),
	),
	makeSession({ id: "d1", name: "pricing", topic: "discovery" }),
];

const master: MapMaster = {
	focused: false,
	thinking: false,
	error: null,
	needCount: 1,
	calmTopics: 2,
	empty: false,
	item: null,
	inputSelected: false,
	input: null,
	lastMessage: null,
};

function draw(
	opts: {
		focusId?: string | null;
		width?: number;
		height?: number;
		list?: Session[];
		master?: Partial<MapMaster>;
		focusSuggestion?: string;
	} = {},
) {
	return drawMap({
		width: opts.width ?? 200,
		height: opts.height ?? 48,
		groups: groupTopics(opts.list ?? sessions),
		focusId: opts.focusId ?? null,
		focusSuggestion: opts.focusSuggestion ?? null,
		reply: null,
		master: { ...master, ...opts.master },
	});
}

describe("drawMap", () => {
	test("master in the centre, topics as bubbles on both sides", () => {
		const { canvas, master: box, rows } = draw();
		const text = canvas.toString();
		expect(text).toContain("◆ master");
		expect(text).toContain("1 thing needs you · 2 topics calm");
		expect(text).toContain("backend · ◐1 ●1");
		expect(text).toContain("infra · quiet");
		expect(text).toContain("discovery · quiet");
		// Centred horizontally, with bubbles left and right of it.
		expect(Math.abs(box.x + box.w / 2 - 100)).toBeLessThanOrEqual(1);
		expect(rows.some((r) => r.x + r.w <= box.x)).toBe(true);
		expect(rows.some((r) => r.x >= box.x + box.w)).toBe(true);
		// No PR info on the map.
		expect(text).not.toContain("PR");
	});

	test("one line per agent with glyph and ⚑; a bubble folds past five", () => {
		const { canvas, rows } = draw();
		const text = canvas.toString();
		expect(text).toMatch(/◐ api-auth ⚑/);
		expect(text).toContain("● sync-worker");
		expect(text).toContain("+2 more");
		expect(text).not.toContain("ci-c6");
		expect(rows.map((r) => r.sessionId)).not.toContain("c6");
		expect(rows.every((r) => r.h === 1)).toBe(true);
	});

	test("waiting rows are inverse yellow", () => {
		const { canvas, rows } = draw();
		const row = rows.find((r) => r.sessionId === "a1");
		const runs = canvas.rows()[row?.y ?? -1] ?? [];
		const name = runs.find((r) => r.text.includes("api-auth"));
		expect(name?.style).toMatchObject({ fg: "black", bg: "yellow" });
	});

	test("a focused agent past the fold is swapped in", () => {
		const { canvas, rows } = draw({ focusId: "c7" });
		expect(canvas.toString()).toContain("▸ ");
		expect(rows.map((r) => r.sessionId)).toContain("c7");
		expect(rows.map((r) => r.sessionId)).not.toContain("c5");
	});

	test("the bubble holding focus gets the heavy outline; WASD moves between bubbles", () => {
		const { canvas, bubbles, master: box } = draw({ focusId: "c2" });
		const text = canvas.toString();
		expect(text).toMatch(/┏━ infra · quiet ━+┓/);
		expect(text).toMatch(/╭─ backend/);
		expect(bubbles.map((b) => b.id).sort()).toEqual([
			"backend",
			"discovery",
			"infra",
		]);
		const nodes = [{ ...box, id: "master" }, ...bubbles];
		const infra = bubbles.find((b) => b.id === "infra");
		const across = moveFocus(
			nodes,
			"infra",
			infra && infra.x > box.x ? "left" : "right",
		);
		expect(across).toBe("master");
	});

	test("the focused row shows the master's suggestion under it", () => {
		const { canvas } = draw({ focusId: "a2", focusSuggestion: "Reply ok" });
		expect(canvas.toString()).toMatch(/◆ Reply ok +y e n/);
	});

	test("the master box shows the selected NEEDS YOU item and the input", () => {
		const a1 = sessions[0] as Session;
		const { canvas } = draw({
			master: {
				focused: true,
				item: {
					kind: "session",
					session: a1,
					suggestion: "Approve it",
					reply: null,
				},
				input: fieldAt("hello"),
			},
		});
		const text = withCursor(canvas);
		expect(text).toContain("┏");
		expect(text).toContain("◐ api-auth ⚑");
		expect(text).toContain("set TTL to 15m?");
		expect(text).toContain("◆ Approve it");
		expect(text).toContain("› hello█");
	});

	test("a long message grows the master's input to four lines, then keeps its end", () => {
		const base = draw({ master: { input: fieldAt("hi") } });
		const words = "word ".repeat(40).trim();
		const long = draw({ master: { input: fieldAt(words) } });
		expect(long.master.h).toBe(base.master.h + 3);
		expect(long.master.y).toBe(base.master.y);
		const lines = withCursor(long.canvas)
			.split("\n")
			.filter((l) => l.includes("word"));
		expect(lines).toHaveLength(4);
		expect(lines.join("")).toContain("…");
		expect(lines.at(-1)).toContain("█");
		expect(long.canvas.toString().match(/┏|╭/g)?.length).toBeGreaterThan(0);
	});

	test("an @ list shows over the input, the selected name marked", () => {
		const { canvas, master: box } = draw({
			master: {
				focused: true,
				input: fieldAt("ask @a"),
				mentions: { names: ["api-auth", "sync-worker"], selected: 1 },
			},
		});
		const lines = withCursor(canvas).split("\n");
		const at = lines.findIndex((l) => l.includes("› ask @a█"));
		expect(lines[at - 2]).toContain("  @api-auth");
		expect(lines[at - 1]).toContain("▸ @sync-worker");
		expect(box.h).toBe(8);
	});

	test("first run shows how to start", () => {
		const { canvas } = draw({
			list: [],
			master: { empty: true, needCount: 0 },
		});
		expect(canvas.toString()).toContain("No sessions yet. Press n");
	});

	test("fits at 80 × 24", () => {
		const { canvas, rows, master: box } = draw({ width: 80, height: 22 });
		for (const r of rows) {
			expect(r.x).toBeGreaterThanOrEqual(0);
			expect(r.x + r.w).toBeLessThanOrEqual(80);
		}
		expect(box.x).toBeGreaterThan(0);
		expect(canvas.toString()).toContain("◆ master");
	});

	test("A and D cross the master between the two columns", () => {
		const { rows, master: box } = draw();
		const nodes = [
			{ ...box, id: "master" },
			...rows.map((r) => ({ ...r, id: r.sessionId })),
		];
		const right = rows.find((r) => r.x > box.x) as (typeof rows)[number];
		expect(moveFocus(nodes, right.sessionId, "left")).toBe("master");
		const back = moveFocus(nodes, "master", "right");
		expect(rows.find((r) => r.sessionId === back)?.x).toBe(right.x);
	});
});

test("visibleRows keeps the first five and swaps in the focused one", () => {
	const list = ["1", "2", "3", "4", "5", "6", "7"].map((id) =>
		makeSession({ id }),
	);
	expect(visibleRows(list, null).shown.map((s) => s.id)).toEqual([
		"1",
		"2",
		"3",
		"4",
		"5",
	]);
	const focused = visibleRows(list, "7");
	expect(focused.shown.map((s) => s.id)).toEqual(["1", "2", "3", "4", "7"]);
	expect(focused.hidden).toBe(2);
});

test("a selected Slack item shows in the master box, like any NEEDS YOU item", () => {
	const item = {
		id: "C1:1",
		channelId: "C1",
		channel: "#eng",
		author: "Ana",
		text: "is the migration done?",
		reason: "mention" as const,
		action: "Answer whether the migration is done",
		ts: "1",
		threadTs: "1",
		permalink: null,
		at: 1,
	};
	const slack = {
		kind: "slack" as const,
		item,
		suggestion: null,
		reply: null,
		now: 3 * 3600_000 + 1,
	};
	const text = draw({
		master: { focused: true, needCount: 3, item: slack },
	}).canvas.toString();
	expect(text).toContain("3 things need you");
	expect(text).toMatch(/▸@ Ana in #eng +3h/);
	expect(text).toContain("Answer whether the migration is done");
	// No Slack box of its own any more.
	expect(text).not.toContain(" slack ");
	const dm = draw({
		master: {
			focused: true,
			item: { ...slack, item: { ...item, reason: "dm" } },
		},
	}).canvas.toString();
	expect(dm).toMatch(/▸@ Ana · dm +3h/);
	// The master's suggestion sits under it, with its keys.
	const suggested = draw({
		master: {
			focused: true,
			item: {
				...slack,
				suggestion: {
					itemId: "C1:1",
					kind: "reply",
					label: 'Reply "merged in #42"',
					text: "merged in #42",
					sessionId: null,
					status: "pending",
				},
			},
		},
	}).canvas.toString();
	expect(suggested).toMatch(/◆ slack Reply "merged in #42" +y e n/);
	const asked = draw({
		master: {
			focused: true,
			item: {
				...slack,
				suggestion: {
					itemId: "C1:1",
					kind: "ask",
					label: "Asked api-auth; waiting for its answer",
					text: "did it ship?",
					sessionId: "s1",
					status: "asked",
				},
			},
		},
	}).canvas.toString();
	expect(asked).toContain("◆ slack Asked api-auth; waiting for");
	expect(asked).not.toContain("y e n");
});

test("why Slack cannot be read shows in the master box", () => {
	const text = draw({
		master: { slackError: "Slack needs a login: run serenity slack login" },
	}).canvas.toString();
	expect(text).toContain("Slack needs a login");
});

test("a selected queued reply shows in the master box with its keys; the status counts the queue", () => {
	const queued = {
		kind: "queued" as const,
		session: sessions[0] as Session,
		text: "Yes, set the TTL to 15 minutes and add a test for expiry",
		reply: null,
	};
	const text = draw({
		master: { focused: true, queueCount: 2, item: queued },
	}).canvas.toString();
	expect(text).toContain("1 thing needs you · 2 queued");
	expect(text).toMatch(/▸→ api-auth +y e n/);
	expect(text).toContain("Yes, set the TTL to 15 minutes");
	const editing = withCursor(
		draw({
			master: { focused: true, item: { ...queued, reply: fieldAt("No") } },
		}).canvas,
	);
	expect(editing).toContain("› No█");
});

describe("a cursor moved back into the text (ADR 0042)", () => {
	test("in the master's input: the character under it inverted, no █ after the text", () => {
		const text = withCursor(
			draw({ master: { input: { text: "hello", cursor: 2 } } }).canvas,
		);
		expect(text).toContain("› he[l]lo");
		expect(text).not.toContain("hello█");
	});

	test("in a reply: a long text shows the part around the cursor", () => {
		const queued = {
			kind: "queued" as const,
			session: sessions[0] as Session,
			text: "",
			reply: { text: `start ${"x".repeat(80)}`, cursor: 0 },
		};
		const text = withCursor(
			draw({ master: { focused: true, item: queued } }).canvas,
		);
		expect(text).toMatch(/› \[s\]tart x+…/);
	});
});

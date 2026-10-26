import { describe, expect, test } from "bun:test";
import { groupTopics, type Session } from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import { drawMap, type MapMaster, visibleRows } from "../src/map";
import { moveFocus } from "../src/topics";

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
	inputText: null,
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
		replyText: null,
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
					replyText: null,
				},
				inputText: "hello",
			},
		});
		const text = canvas.toString();
		expect(text).toContain("┏");
		expect(text).toContain("◐ api-auth ⚑");
		expect(text).toContain("set TTL to 15m?");
		expect(text).toContain("◆ Approve it");
		expect(text).toContain("› hello█");
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

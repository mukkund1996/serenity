import { describe, expect, test } from "bun:test";
import { type Canvas, groupTopics, type Ping } from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import { drawMap } from "../src/map";
import { PULSE_MS, PULSE_PHASE_MS, pulseEnd, pulsing } from "../src/pulse";
import { drawTopics } from "../src/topics";

/** The character and style drawn at one cell. */
function cellAt(canvas: Canvas, x: number, y: number) {
	let col = 0;
	for (const run of canvas.rows()[y] ?? []) {
		const chars = [...run.text];
		if (x < col + chars.length) return { ch: chars[x - col], style: run.style };
		col += chars.length;
	}
	return null;
}

const toSession: Ping = { sessionId: "a", to: "session", at: 1_000 };
const toMaster: Ping = { sessionId: "b", to: "master", at: 1_000 };

describe("pulsing", () => {
	test("blinks: lit, plain, lit… and then nothing", () => {
		const lit = (t: number) =>
			pulsing([toSession], 1_000 + t).sessions.has("a");
		expect(lit(0)).toBe(true);
		expect(lit(PULSE_PHASE_MS)).toBe(false);
		expect(lit(2 * PULSE_PHASE_MS)).toBe(true);
		expect(lit(PULSE_MS)).toBe(false);
		expect(lit(PULSE_MS + 2 * PULSE_PHASE_MS)).toBe(false);
	});

	test("a ping to the master lights the master, not the session", () => {
		const now = pulsing([toMaster], 1_000);
		expect(now.master).toBe(true);
		expect(now.sessions.size).toBe(0);
	});

	test("a ping from ahead of the clock waits for it", () => {
		expect(pulsing([toSession], 999).sessions.size).toBe(0);
	});

	test("ends with the latest ping's pulse; nothing to run without pings", () => {
		expect(pulseEnd([])).toBeNull();
		expect(pulseEnd([toSession, { ...toMaster, at: 1_500 }])).toBe(
			1_500 + PULSE_MS,
		);
	});
});

const sessions = [
	makeSession({ id: "a", name: "api-auth", topic: "backend", status: "idle" }),
	makeSession({ id: "b", name: "web", topic: "front", status: "idle" }),
];

describe("lit nodes", () => {
	test("on the map: the row's name and its bubble turn magenta, the master's frame heavy", () => {
		const { canvas, rows, master } = drawMap({
			width: 160,
			height: 40,
			groups: groupTopics(sessions),
			focusId: null,
			replyText: null,
			pulse: new Set(["a"]),
			master: {
				focused: false,
				thinking: false,
				error: null,
				needCount: 0,
				calmTopics: 2,
				empty: false,
				item: null,
				inputSelected: false,
				inputText: null,
				lastMessage: null,
				pulse: true,
			},
		});
		const text = canvas.toString();
		expect(text).toMatch(/┏━ backend/);
		expect(text).toMatch(/╭─ front/);
		const row = rows.find((r) => r.sessionId === "a");
		const name = canvas
			.rows()
			[row?.y ?? -1]?.find((r) => r.text.includes("api-auth"));
		expect(name?.style).toMatchObject({ fg: "magentaBright", bold: true });
		expect(cellAt(canvas, master.x, master.y)).toMatchObject({
			ch: "┏",
			style: { fg: "magentaBright" },
		});
	});

	test("in the topics zoom: the card's frame turns heavy magenta", () => {
		const { canvas, cards } = drawTopics({
			width: 140,
			height: 30,
			masterRow: 15,
			groups: groupTopics(sessions),
			focusId: null,
			replyText: null,
			pulse: new Set(["a"]),
		});
		const corner = (id: string) => {
			const c = cards.find((c) => c.sessionId === id);
			return cellAt(canvas, c?.x ?? -1, c?.y ?? -1);
		};
		expect(corner("a")).toMatchObject({
			ch: "┏",
			style: { fg: "magentaBright", bold: true },
		});
		expect(corner("b")?.ch).toBe("┌");
	});
});

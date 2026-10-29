import { describe, expect, test } from "bun:test";
import { type Canvas, groupTopics, type Ping } from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import { drawMap } from "../src/map";
import {
	glow,
	PULSE_FRAME_MS,
	PULSE_MS,
	pulseColor,
	pulseEnd,
	pulsing,
} from "../src/pulse";
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
/** The glow's colour at its height, half way through. */
const PEAK = pulseColor(1);

describe("glow", () => {
	test("eases in to full half way through, and out again", () => {
		const at = (t: number) => glow(1_000, 1_000 + t);
		expect(at(0)).toBe(0);
		expect(at(PULSE_MS / 2)).toBeCloseTo(1);
		expect(at(PULSE_MS / 4)).toBeCloseTo(0.5);
		expect(at((3 * PULSE_MS) / 4)).toBeCloseTo(0.5);
		expect(at(PULSE_MS)).toBe(0);
		expect(at(-1)).toBe(0);
	});

	test("never jumps: one frame changes it by a fraction at most", () => {
		let last = 0;
		for (let t = 0; t <= PULSE_MS; t += PULSE_FRAME_MS) {
			const level = glow(0, t);
			expect(Math.abs(level - last)).toBeLessThan(0.2);
			last = level;
		}
	});

	test("rises, then falls: no blinking on and off", () => {
		const levels: number[] = [];
		for (let t = 0; t < PULSE_MS; t += PULSE_FRAME_MS) levels.push(glow(0, t));
		const top = levels.indexOf(Math.max(...levels));
		for (let i = 1; i <= top; i++)
			expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1] as number);
		for (let i = top + 1; i < levels.length; i++)
			expect(levels[i]).toBeLessThanOrEqual(levels[i - 1] as number);
	});
});

describe("pulseColor", () => {
	test("runs from a dusky magenta to bright magenta", () => {
		expect(pulseColor(0)).toBe("#875f87");
		expect(PEAK).toBe("#ff5fff");
		expect(pulseColor(0.5)).toMatch(/^#[0-9a-f]{6}$/);
		expect(pulseColor(0.5)).not.toBe(pulseColor(0));
		expect(pulseColor(0.5)).not.toBe(PEAK);
	});

	test("a few steps, so neighbouring frames often draw the same", () => {
		const colours = new Set<string>();
		for (let t = 0; t < PULSE_MS; t += 5) colours.add(pulseColor(glow(0, t)));
		expect(colours.size).toBeLessThanOrEqual(13);
	});
});

describe("pulsing", () => {
	test("lights the session with the glow's colour while it is visible", () => {
		const at = (t: number) => pulsing([toSession], 1_000 + t).sessions.get("a");
		expect(at(0)).toBeUndefined();
		expect(at(PULSE_MS / 2)).toBe(PEAK);
		expect(at(PULSE_MS / 4)).toBe(pulseColor(glow(0, PULSE_MS / 4)));
		expect(at(PULSE_MS)).toBeUndefined();
	});

	test("a ping to the master lights the master, not the session", () => {
		const now = pulsing([toMaster], 1_000 + PULSE_MS / 2);
		expect(now.master).toBe(PEAK);
		expect(now.sessions.size).toBe(0);
	});

	test("a ping from ahead of the clock waits for it", () => {
		expect(pulsing([toSession], 999).sessions.size).toBe(0);
	});

	test("two pings to one node: the brighter glow shows", () => {
		const later = { ...toSession, at: 1_000 + PULSE_MS / 2 };
		expect(
			pulsing([toSession, later], 1_000 + PULSE_MS / 2).sessions.get("a"),
		).toBe(PEAK);
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
	test("on the map: the row's name and its bubble take the glow's colour; frames keep their shape", () => {
		const { canvas, rows, master } = drawMap({
			width: 160,
			height: 40,
			groups: groupTopics(sessions),
			focusId: null,
			reply: null,
			pulse: new Map([["a", PEAK]]),
			master: {
				focused: false,
				thinking: false,
				error: null,
				needCount: 0,
				calmTopics: 2,
				empty: false,
				item: null,
				inputSelected: false,
				input: null,
				lastMessage: null,
				pulse: PEAK,
			},
		});
		const text = canvas.toString();
		expect(text).toMatch(/╭─ backend/);
		expect(text).toMatch(/╭─ front/);
		const row = rows.find((r) => r.sessionId === "a");
		const name = canvas
			.rows()
			[row?.y ?? -1]?.find((r) => r.text.includes("api-auth"));
		expect(name?.style).toMatchObject({ fg: PEAK });
		expect(cellAt(canvas, master.x, master.y)).toMatchObject({
			ch: "╭",
			style: { fg: PEAK },
		});
	});

	test("in the topics zoom: the card's frame takes the glow's colour, not a heavier line", () => {
		const { canvas, cards } = drawTopics({
			width: 140,
			height: 30,
			masterRow: 15,
			groups: groupTopics(sessions),
			focusId: null,
			reply: null,
			pulse: new Map([["a", PEAK]]),
		});
		const corner = (id: string) => {
			const c = cards.find((c) => c.sessionId === id);
			return cellAt(canvas, c?.x ?? -1, c?.y ?? -1);
		};
		expect(corner("a")).toMatchObject({ ch: "┌", style: { fg: PEAK } });
		expect(corner("a")?.style.dim).toBeFalsy();
		expect(corner("b")).toMatchObject({ ch: "┌", style: { dim: true } });
	});
});

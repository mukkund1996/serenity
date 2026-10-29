import type { Color, Ping } from "@serenity/core";

/**
 * The pulse (ADR 0039, eased by 0042): when the master messages a session,
 * its card (or row) glows magenta, easing in and out; when the session
 * answers, the master's frame does. The map re-renders only while a pulse
 * runs, never when idle.
 */

/** One swell, in and out. */
export const PULSE_MS = 1400;
/** How often the clock ticks while a pulse runs: about 14 frames a second. */
export const PULSE_FRAME_MS = 70;

/** The glow's two ends: a dusky magenta near a calm frame, and the master's bright magenta. */
const FROM = [0x87, 0x5f, 0x87] as const;
const PEAK = [0xff, 0x5f, 0xff] as const;
/** Levels the glow takes, so neighbouring frames often draw alike. */
const STEPS = 12;

/**
 * How lit a pulse that started at `at` is at `now`, 0 to 1: it eases in to
 * full at the middle and out again (sin²), 0 outside the pulse.
 */
export function glow(at: number, now: number): number {
	const t = now - at;
	if (t < 0 || t >= PULSE_MS) return 0;
	return Math.sin((Math.PI * t) / PULSE_MS) ** 2;
}

const hex = (n: number) => Math.round(n).toString(16).padStart(2, "0");

/** The frame colour at a glow `level`, between dusky and bright magenta. */
export function pulseColor(level: number): Color {
	const k = Math.round(Math.max(0, Math.min(1, level)) * STEPS) / STEPS;
	const [r, g, b] = FROM.map(
		(from, i) => from + ((PEAK[i] ?? from) - from) * k,
	);
	return `#${hex(r ?? 0)}${hex(g ?? 0)}${hex(b ?? 0)}`;
}

/** Below this the glow is too faint to draw; the node keeps its own frame. */
const VISIBLE = 0.05;

/** What is lit at `now`, with its colour: these sessions, and the master. */
export function pulsing(
	pings: Ping[],
	now: number,
): { sessions: Map<string, Color>; master: Color | null } {
	const levels = new Map<string, number>();
	let master = 0;
	for (const p of pings) {
		const level = glow(p.at, now);
		if (p.to === "master") master = Math.max(master, level);
		else levels.set(p.sessionId, Math.max(levels.get(p.sessionId) ?? 0, level));
	}
	const sessions = new Map<string, Color>();
	for (const [id, level] of levels)
		if (level >= VISIBLE) sessions.set(id, pulseColor(level));
	return {
		sessions,
		master: master >= VISIBLE ? pulseColor(master) : null,
	};
}

/** When the latest pulse ends, or null when there are no pings. */
export function pulseEnd(pings: Ping[]): number | null {
	if (!pings.length) return null;
	return Math.max(...pings.map((p) => p.at)) + PULSE_MS;
}

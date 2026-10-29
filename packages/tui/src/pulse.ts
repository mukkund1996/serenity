import type { Ping, Style } from "@serenity/core";

/**
 * The pulse (ADR 0039): when the master messages a session, its card (or
 * row) blinks magenta; when the session answers, the master's frame does.
 * The map re-renders only while a pulse runs, never when idle.
 */

/** One blink: lit, then plain. */
export const PULSE_PHASE_MS = 200;
/** Three blinks. */
export const PULSE_MS = 6 * PULSE_PHASE_MS;

/** The frame a node takes while lit. */
export const PULSE: Style = { fg: "magentaBright", bold: true };

/** Lit at `now`: in an even phase of a pulse that has not run its course. */
function lit(at: number, now: number): boolean {
	const t = now - at;
	return t >= 0 && t < PULSE_MS && Math.floor(t / PULSE_PHASE_MS) % 2 === 0;
}

/** What is lit at `now`: these sessions, and whether the master is. */
export function pulsing(
	pings: Ping[],
	now: number,
): { sessions: Set<string>; master: boolean } {
	const sessions = new Set<string>();
	let master = false;
	for (const p of pings) {
		if (!lit(p.at, now)) continue;
		if (p.to === "master") master = true;
		else sessions.add(p.sessionId);
	}
	return { sessions, master };
}

/** When the latest pulse ends, or null when there are no pings. */
export function pulseEnd(pings: Ping[]): number | null {
	if (!pings.length) return null;
	return Math.max(...pings.map((p) => p.at)) + PULSE_MS;
}

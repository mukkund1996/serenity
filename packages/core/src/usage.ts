import type { Session, Usage, UsageWindow, Wait } from "./domain";

/** Waits that ended this long ago or less make the average (ADR 0020). */
export const WAIT_WINDOW_MS = 24 * 60 * 60_000;

/** Epoch ms from Claude's `resets_at`: epoch seconds, ms, or an ISO date. */
function epochMs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value))
		return value < 1e12 ? value * 1000 : value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? null : parsed;
	}
	return null;
}

function usageWindow(value: unknown): UsageWindow | null {
	const w = value as { used_percentage?: unknown; resets_at?: unknown } | null;
	if (typeof w?.used_percentage !== "number") return null;
	if (!Number.isFinite(w.used_percentage)) return null;
	return {
		usedPercent: Math.min(100, Math.max(0, w.used_percentage)),
		resetsAt: epochMs(w.resets_at),
	};
}

/**
 * Reads the `rate_limits` of Claude Code's status line JSON. Claude sends it
 * only on a subscription plan, and leaves it out until its first API reply.
 */
export function parseRateLimits(rateLimits: unknown, at: number): Usage | null {
	const r = rateLimits as { five_hour?: unknown; seven_day?: unknown } | null;
	if (!r || typeof r !== "object") return null;
	const session = usageWindow(r.five_hour);
	const week = usageWindow(r.seven_day);
	return session || week ? { session, week, at } : null;
}

const sameWindow = (a: UsageWindow | null, b: UsageWindow | null) =>
	a?.usedPercent === b?.usedPercent && a?.resetsAt === b?.resetsAt;

/** True when the numbers differ; the report time alone does not count. */
export function usageChanged(prev: Usage | null, next: Usage): boolean {
	return (
		!prev ||
		!sameWindow(prev.session, next.session) ||
		!sameWindow(prev.week, next.week)
	);
}

/**
 * A window whose reset has passed is back at 0, even if no session has
 * reported since.
 */
export function currentWindow(
	window: UsageWindow | null,
	now: number,
): UsageWindow | null {
	if (!window || window.resetsAt === null || window.resetsAt > now)
		return window;
	return { usedPercent: 0, resetsAt: null };
}

/**
 * Tracks the wait on you across one session update: when it began, and the
 * wait that just ended, if any. A wait ends when the session leaves
 * "waiting" for anything but ended or archived; those were never answered.
 */
export function waitChange(
	prev: Session,
	next: Session,
	now: number,
): { waitingSince: number | null; ended: Wait | null } {
	if (next.status === "waiting")
		return {
			waitingSince: prev.status === "waiting" ? prev.waitingSince : now,
			ended: null,
		};
	const answered =
		prev.status === "waiting" &&
		prev.waitingSince !== null &&
		next.status !== "dead" &&
		next.status !== "archived";
	return {
		waitingSince: null,
		ended: answered
			? {
					repo: next.repo,
					sessionId: next.id,
					startedAt: prev.waitingSince as number,
					endedAt: now,
				}
			: null,
	};
}

export function averageWait(waits: Wait[]): number | null {
	if (!waits.length) return null;
	const total = waits.reduce((sum, w) => sum + (w.endedAt - w.startedAt), 0);
	return total / waits.length;
}

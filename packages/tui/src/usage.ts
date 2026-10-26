import {
	type Color,
	currentWindow,
	type Usage,
	type UsageWindow,
} from "@serenity/core";

/** Past this share of a limit the value turns yellow and shows its reset. */
const HIGH_PERCENT = 80;
/** Past this it turns red. */
const CRITICAL_PERCENT = 95;

/** One labelled value of the usage bar, e.g. "session" "42%". */
export interface UsagePart {
	label: string;
	value: string;
	color: Color;
}

/** "45s", "3m", "1h05m", "2d3h". */
export function shortDuration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))}s`;
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

function limitPart(
	label: string,
	window: UsageWindow | null,
	now: number,
): UsagePart {
	const w = currentWindow(window, now);
	if (!w) return { label, value: "—", color: "gray" };
	const percent = Math.round(w.usedPercent);
	const high = percent >= HIGH_PERCENT;
	const reset =
		high && w.resetsAt !== null ? ` ↻${shortDuration(w.resetsAt - now)}` : "";
	return {
		label,
		value: `${percent}%${reset}`,
		color:
			percent >= CRITICAL_PERCENT ? "red" : high ? "yellow" : "whiteBright",
	};
}

/**
 * The header's usage bar (ADR 0020): Claude's 5-hour session limit, its
 * weekly limit, and how long sessions waited on you on average.
 */
export function usageParts(
	usage: Usage | null,
	averageWaitMs: number | null,
	now: number,
): UsagePart[] {
	return [
		limitPart("session", usage?.session ?? null, now),
		limitPart("week", usage?.week ?? null, now),
		averageWaitMs === null
			? { label: "avg wait", value: "—", color: "gray" }
			: {
					label: "avg wait",
					value: shortDuration(averageWaitMs),
					color: "whiteBright",
				},
	];
}

import type { Color, PrTone, Session, SessionStatus } from "@serenity/core";

/** The only three status glyphs (design handover, "Status language"). */
export function glyph(
	status: SessionStatus,
): { ch: string; color: Color } | null {
	switch (status) {
		case "waiting":
			return { ch: "◐", color: "yellow" };
		case "working":
			return { ch: "●", color: "blue" };
		case "done":
			return { ch: "✓", color: "green" };
		default:
			return null;
	}
}

/**
 * A topic card's outline: its status glyph's colour, drawn dim so a screen
 * of cards stays calm, grey when quiet. The focused card is always white,
 * whatever its status.
 */
export function frameColor(status: SessionStatus, focused: boolean): Color {
	if (focused) return "whiteBright";
	return glyph(status)?.color ?? "gray";
}

/** Name colour on cards and lists; idle and archived are deliberately quiet. */
export function nameColor(status: SessionStatus): Color {
	if (status === "idle") return "white";
	if (status === "archived" || status === "dead") return "gray";
	return "default";
}

/** The 1–2 sentence grey text on a card until the master writes summaries. */
export function cardText(session: Session): string {
	const ended =
		session.status === "dead"
			? session.pinned
				? "Ended. Enter resumes it."
				: "Session ended."
			: session.status === "archived"
				? "Archived."
				: null;
	if (ended) return session.summary ? `${ended} ${session.summary}` : ended;
	if (session.summary) return session.summary;
	if (session.status === "waiting" && session.ask) return session.ask;
	if (session.status === "working" && session.lastPrompt)
		return `Working on: ${session.lastPrompt}`;
	if (session.lastAssistantMessage) return session.lastAssistantMessage;
	return "New session. Press i to send a first prompt.";
}

/** The one grey line under a session in the master's NEEDS YOU list. */
export function askLine(session: Session): string {
	if (session.status === "waiting") return session.ask ?? "needs you";
	if (session.status === "dead") return "session ended";
	if (session.status === "done") return "finished";
	return session.status;
}

/** PR status word colours (ADR 0011). */
export const TONE_COLOR: Record<PrTone, Color> = {
	merged: "cyan",
	good: "green",
	bad: "red",
	warn: "yellow",
	quiet: "gray",
};

/** How long ago, in the largest whole unit: "now", "5m", "2h", "3d", "4w". */
export function age(at: number, now: number): string {
	if (!at) return "";
	const minutes = Math.floor(Math.max(0, now - at) / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return days < 14 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

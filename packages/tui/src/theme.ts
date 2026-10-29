import type { Color, PrTone, Session, SessionStatus } from "@serenity/core";

/** The ◈ icon's green, as on getserenity.dev; brand only, never a status. */
export const BRAND_COLOR = "#7fc77f";

/**
 * The master's queue (ADR 0040): replies it wants to send, waiting for y.
 * Coral, apart from NEEDS YOU's yellow and the master's magenta.
 */
export const QUEUE_COLOR: Color = "#ff875f";

/** Marks a ◆ draft in NEEDS YOU that goes to Slack, not to a session (ADR 0040). */
export const SLACK_COLOR: Color = "#36c5f0";

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
			? endedText(session)
			: session.status === "archived"
				? "Archived."
				: null;
	if (ended) return session.summary ? `${ended} ${session.summary}` : ended;
	// A restart is news until the next prompt (ADR 0044).
	if (session.exitNote)
		return session.summary
			? `${capitalize(session.exitNote)}. ${session.summary}`
			: `${capitalize(session.exitNote)}.`;
	if (session.summary) return session.summary;
	if (session.status === "waiting" && session.ask) return session.ask;
	if (session.status === "working" && session.lastPrompt)
		return `Working on: ${session.lastPrompt}`;
	if (session.lastAssistantMessage) return session.lastAssistantMessage;
	return "New session. Press i to send a first prompt.";
}

/** A dead session's card line, with why claude was not restarted (ADR 0044). */
export function endedText(session: Session): string {
	if (session.pinned) return "Ended. Enter resumes it.";
	return session.exitNote
		? `Session ended: ${session.exitNote}.`
		: "Session ended.";
}

const capitalize = (text: string) =>
	text.charAt(0).toUpperCase() + text.slice(1);

/** The one grey line under a session in the master's NEEDS YOU list. */
export function askLine(session: Session): string {
	if (session.status === "waiting") return session.ask ?? "needs you";
	if (session.status === "dead")
		return session.exitNote ? `ended: ${session.exitNote}` : "session ended";
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

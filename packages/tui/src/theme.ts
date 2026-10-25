import type { Color, Session, SessionStatus } from "@serenity/core";

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

/** Name colour on cards and lists; idle and archived are deliberately quiet. */
export function nameColor(status: SessionStatus): Color {
	if (status === "idle") return "white";
	if (status === "archived" || status === "dead") return "gray";
	return "default";
}

/** The 1–2 sentence grey text on a card until the master writes summaries. */
export function cardText(session: Session): string {
	if (session.summary) return session.summary;
	if (session.status === "waiting" && session.ask) return session.ask;
	if (session.status === "dead") return "Session ended.";
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

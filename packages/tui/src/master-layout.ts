import {
	type MasterMessage,
	type ReviewRequest,
	type SlackState,
	wrap,
} from "@serenity/core";

/**
 * What the master panel shows in the rows it has (ADR 0012). NEEDS YOU, the
 * conversation and the input always show; the rows left over go to SLACK
 * (whole or not at all, ADR 0023), then REVIEW, trimmed to fit or dropped.
 * MY PRS is off for now. The session counts sit in the header.
 */

/** How many NEEDS YOU items fit; the rest are summarised as "+N more". */
export const MAX_NEED_ITEMS = 5;
/** Indent of a NEEDS YOU item's detail lines, under its name. */
export const NEED_INDENT = 4;
/** Columns kept right of a suggestion for its y / e / n chips. */
const CHIPS_W = 8;

/** A NEEDS YOU item's detail (its ask, a permission's detail): up to 2 lines, never cut short mid-line. */
export function needLines(text: string, inner: number): string[] {
	return wrap(text, inner - NEED_INDENT, 2);
}

/** A suggestion's label beside its chips: up to 2 lines. */
export function suggestionLines(label: string, inner: number): string[] {
	return wrap(label, inner - NEED_INDENT - 2 - CHIPS_W, 2);
}

/** Lines of a Slack message's text under its channel and author. */
export const SLACK_TEXT_LINES = 2;

/**
 * Rows the SLACK section's body takes: an item and its suggestion, if any
 * (ADR 0024), or the reason Slack cannot be read. Sized for the tallest item,
 * so stepping through them with `[` `]` never drops the section.
 */
export function slackRows(slack: SlackState | null): number {
	if (!slack) return 0;
	if (!slack.items.length) return slack.error ? 1 : 0;
	const suggested = slack.items.some((item) =>
		slack.suggestions.some((g) => g.itemId === item.id),
	);
	return 1 + SLACK_TEXT_LINES + (suggested ? 1 : 0);
}

/** Width of the "you" / "◆" column before a conversation message. */
export const SPEAKER_W = 6;
export const CONVERSATION_EMPTY =
	"Press g to ask the master about your sessions.";

export interface MasterPlanInput {
	/** Rows the panel may take, frame included. */
	height: number;
	/** Text width inside the frame. */
	inner: number;
	/** No sessions on the map: the empty state replaces the status and NEEDS YOU. */
	empty: boolean;
	/** NEEDS YOU in order (permissions, then sessions) with each item's rows; a blank row separates items. */
	needs: Array<{ id: string; rows: number }>;
	selected: string | null;
	conversation: MasterMessage[];
	/** Slack's inbox when the repo has it on. */
	slack: SlackState | null;
	reviews: ReviewRequest[];
}

export interface MasterPlan {
	/** The window of NEEDS YOU on screen; it slides to keep the selection shown. */
	needs: { start: number; count: number; hidden: number };
	/** Whether the SLACK section fits. */
	slack: boolean;
	reviews: ReviewRequest[];
}

/** A section's blank line and header. */
const HEADER_ROWS = 2;

export function planMaster(input: MasterPlanInput): MasterPlan {
	const at = input.needs.findIndex((n) => n.id === input.selected);
	const start = Math.max(0, at - MAX_NEED_ITEMS + 1);
	const shown = input.needs.slice(start, start + MAX_NEED_ITEMS);
	const hidden = input.needs.length - shown.length;

	// Frame, then the input's blank line and its own frame.
	let fixed = 2 + 4;
	if (input.empty) fixed += 3;
	else {
		fixed += 1;
		if (input.needs.length)
			fixed +=
				HEADER_ROWS +
				shown.reduce((sum, n) => sum + n.rows, 0) +
				Math.max(0, shown.length - 1) +
				(hidden ? 1 : 0);
		fixed += HEADER_ROWS + conversationRows(input.conversation, input.inner);
	}
	let room = input.height - fixed;

	/** Up to `want` rows under a header, or none when not even one fits. */
	const take = (want: number): number => {
		const rows = Math.min(want, room - HEADER_ROWS);
		if (want === 0 || rows < 1) return 0;
		room -= HEADER_ROWS + rows;
		return rows;
	};
	const slackWant = slackRows(input.slack);
	// One message cut short says nothing, so Slack shows whole or not at all.
	const slack = slackWant > 0 && room - HEADER_ROWS >= slackWant;
	if (slack) take(slackWant);
	const reviews = input.reviews.slice(0, take(input.reviews.length));
	return {
		needs: { start, count: shown.length, hidden },
		slack,
		reviews,
	};
}

/** Rows of the conversation's latest exchange, as `Conversation` draws it. */
export function conversationRows(
	messages: MasterMessage[],
	inner: number,
): number {
	const latest = messages.slice(-2);
	if (!latest.length) return wrappedRows(CONVERSATION_EMPTY, inner);
	return latest.reduce(
		(sum, m, i) =>
			sum + (i ? 1 : 0) + wrappedRows(clipLines(m.text, 4), inner - SPEAKER_W),
		0,
	);
}

/** Keeps a message to a few lines; the full history belongs behind M (v1.1). */
export function clipLines(text: string, lines: number): string {
	const kept = text.split("\n").filter(Boolean).slice(0, lines).join("\n");
	return kept.length > 400 ? `${kept.slice(0, 399)}…` : kept;
}

/** Rows `text` takes when word-wrapped to `width`, as Ink's wrap="wrap" does. */
export function wrappedRows(text: string, width: number): number {
	const w = Math.max(1, width);
	let rows = 0;
	for (const line of text.split("\n")) {
		let col = 0;
		rows++;
		for (const word of line.split(" ")) {
			const len = [...word].length;
			const need = col === 0 ? len : col + 1 + len;
			if (need <= w) {
				col = need;
				continue;
			}
			if (col > 0) rows++;
			// A word longer than the line is broken across rows.
			rows += Math.max(0, Math.ceil(len / w) - 1);
			col = len % w || (len ? w : 0);
		}
	}
	return rows;
}

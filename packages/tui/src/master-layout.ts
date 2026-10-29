import { type MasterMessage, type ReviewRequest, wrap } from "@serenity/core";

/**
 * What the master panel shows in the rows it has (ADR 0012). NEEDS YOU
 * (Slack's items among them, ADR 0031), the queue (ADR 0040), the
 * conversation and the input always show; the rows left over go to REVIEW, trimmed to fit or dropped.
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

/** How many queued replies fit; the rest are summarised as "+N more". */
export const MAX_QUEUE_ITEMS = 3;
/** Lines of a queued reply that Enter expands, past which it is cut. */
export const QUEUE_FULL_MAX = 12;

/** A queued reply in full, its own line breaks kept, under its row. */
export function queueLines(text: string, inner: number): string[] {
	const lines = text
		.split("\n")
		.flatMap((line) => wrap(line, inner - NEED_INDENT, QUEUE_FULL_MAX));
	if (lines.length <= QUEUE_FULL_MAX) return lines;
	const kept = lines.slice(0, QUEUE_FULL_MAX);
	kept[QUEUE_FULL_MAX - 1] = `${kept[QUEUE_FULL_MAX - 1]}…`;
	return kept;
}

/** Rows a queued reply takes: its line, and its full text or its edit under it. */
export function queueRows(
	text: string,
	inner: number,
	state: "collapsed" | "expanded" | "editing",
): number {
	if (state === "editing") return 2;
	return state === "expanded" ? 1 + queueLines(text, inner).length : 1;
}

/** Width of the "you" / "◆" column before a conversation message. */
export const SPEAKER_W = 6;
export const CONVERSATION_EMPTY =
	"Press i to ask the master about your sessions.";

export interface MasterPlanInput {
	/** Rows the panel may take, frame included. */
	height: number;
	/** Text width inside the frame. */
	inner: number;
	/** No sessions on the map: the empty state replaces the status and NEEDS YOU. */
	empty: boolean;
	/** NEEDS YOU in order (permissions, sessions, Slack) with each item's rows; a blank row separates items. */
	needs: Array<{ id: string; rows: number }>;
	/** The queue in order, each item's rows: one, more while expanded or edited. */
	queue?: Array<{ id: string; rows: number }>;
	selected: string | null;
	conversation: MasterMessage[];
	/** Why Slack could not be read: one row under the status line. */
	slackError: boolean;
	reviews: ReviewRequest[];
	/** Rows the input takes beyond its one: its extra lines and the @ list over it. */
	inputExtra?: number;
}

export interface MasterPlan {
	/** The window of NEEDS YOU on screen; it slides to keep the selection shown. */
	needs: Window;
	/** The window of the queue on screen, sliding as NEEDS YOU's does. */
	queue: Window;
	reviews: ReviewRequest[];
}

interface Window {
	start: number;
	count: number;
	hidden: number;
}

/** A section's blank line and header. */
const HEADER_ROWS = 2;

/** Up to `max` items, slid down to keep the selected one shown, and the rows they take. */
function windowOf(
	items: Array<{ id: string; rows: number }>,
	selected: string | null,
	max: number,
	gap: number,
): { window: Window; rows: number } {
	const at = items.findIndex((n) => n.id === selected);
	const start = Math.max(0, at - max + 1);
	const shown = items.slice(start, start + max);
	const hidden = items.length - shown.length;
	const rows = items.length
		? HEADER_ROWS +
			shown.reduce((sum, n) => sum + n.rows, 0) +
			gap * Math.max(0, shown.length - 1) +
			(hidden ? 1 : 0)
		: 0;
	return { window: { start, count: shown.length, hidden }, rows };
}

export function planMaster(input: MasterPlanInput): MasterPlan {
	const needs = windowOf(input.needs, input.selected, MAX_NEED_ITEMS, 1);
	const queue = windowOf(input.queue ?? [], input.selected, MAX_QUEUE_ITEMS, 0);

	// Frame, then the input's blank line and its own frame.
	let fixed = 2 + 4 + (input.inputExtra ?? 0) + (input.slackError ? 1 : 0);
	if (input.empty) fixed += 3;
	else
		fixed +=
			1 + HEADER_ROWS + conversationRows(input.conversation, input.inner);
	// Slack's items need the user even before the first session.
	fixed += needs.rows + queue.rows;
	let room = input.height - fixed;

	/** Up to `want` rows under a header, or none when not even one fits. */
	const take = (want: number): number => {
		const rows = Math.min(want, room - HEADER_ROWS);
		if (want === 0 || rows < 1) return 0;
		room -= HEADER_ROWS + rows;
		return rows;
	};
	const reviews = input.reviews.slice(0, take(input.reviews.length));
	return { needs: needs.window, queue: queue.window, reviews };
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

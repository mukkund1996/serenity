import {
	Canvas,
	type MasterMessage,
	type MasterPermission,
	type Session,
	type SlackItem,
	type SlackSuggestion,
	type Style,
	type TopicGroup,
	truncate,
	wrap,
} from "@serenity/core";
import { inputRows, PROMPT_W } from "./master-input";
import {
	age,
	askLine,
	glyph,
	nameColor,
	QUEUE_COLOR,
	SLACK_COLOR,
} from "./theme";
import {
	type CardBox,
	type CardElement,
	counts,
	DIM,
	Links,
	type NodeBox,
} from "./topics";

/**
 * Draws the map zoom (design screen 1): the master box in the centre and
 * every topic as a bubble beside it, one line per agent, joined to the
 * master by right-angle links (ADR 0018). Bubbles fill the left and right
 * columns; a column taller than the screen scrolls to the focused row. The
 * bubble holding focus gets the heavy white frame: WASD moves between
 * bubbles and the arrow keys between the agents inside one.
 */

/** Agents shown per bubble before the rest fold into `+N more`. */
export const MAP_ROWS = 5;
const MASTER_H = 8;
const GAP = 4;
const MAX_BUBBLE_W = 34;

/** The NEEDS YOU item selected on the master, shown in its box. */
export type MasterItem =
	| { kind: "permission"; permission: MasterPermission }
	| {
			kind: "session";
			session: Session;
			suggestion: string | null;
			/** Reply being typed to it, or null. */
			replyText: string | null;
	  }
	| {
			/** A Slack mention or DM that needs the user (ADR 0031). */
			kind: "slack";
			item: SlackItem;
			suggestion: SlackSuggestion | null;
			/** The suggestion's text being edited (e), or null. */
			replyText: string | null;
			now: number;
	  }
	| {
			/** A reply the master wants to send, waiting for y (ADR 0037). */
			kind: "queued";
			session: Session;
			text: string;
			/** Its text being edited (e), or null. */
			replyText: string | null;
	  };

export interface MapMaster {
	focused: boolean;
	thinking: boolean;
	error: string | null;
	/** NEEDS YOU items, Slack's among them, plus permission requests. */
	needCount: number;
	/** Replies in the master's queue (ADR 0037). */
	queueCount?: number;
	/** Why Slack could not be read, or null. */
	slackError?: string | null;
	calmTopics: number;
	/** No sessions at all yet: the first-run hint. */
	empty: boolean;
	item: MasterItem | null;
	inputSelected: boolean;
	/** Text being typed to the master, or null when its input is closed. */
	inputText: string | null;
	/** Session names offered after an `@` in the input, with the selected one. */
	mentions?: { names: string[]; selected: number } | null;
	lastMessage: MasterMessage | null;
}

export interface MapInput {
	width: number;
	height: number;
	groups: TopicGroup[];
	/** The focused agent, or null when the master has focus. */
	focusId: string | null;
	focusElement?: CardElement;
	/** The master's suggestion for the focused agent, shown under its row. */
	focusSuggestion?: string | null;
	/** Text being typed to the focused agent, or null when not replying. */
	replyText: string | null;
	master: MapMaster;
}

export interface MapLayout {
	canvas: Canvas;
	/** One box per agent row on screen. */
	rows: CardBox[];
	/** One box per topic bubble on screen; its id is the topic's name. */
	bubbles: NodeBox[];
	master: NodeBox;
}

/** What the arrow keys step through on a focused agent row; the map shows no PR. */
export function rowElements(hasSuggestion: boolean): CardElement[] {
	return hasSuggestion ? ["card", "suggestion", "reply"] : ["card", "reply"];
}

/**
 * The agents a bubble lists: the first MAP_ROWS, with the focused one
 * swapped in for the last when it would otherwise be folded away.
 */
export function visibleRows(
	sessions: Session[],
	focusId: string | null,
): { shown: Session[]; hidden: number } {
	if (sessions.length <= MAP_ROWS) return { shown: sessions, hidden: 0 };
	const at = sessions.findIndex((s) => s.id === focusId);
	const shown =
		at >= MAP_ROWS
			? [...sessions.slice(0, MAP_ROWS - 1), sessions[at] as Session]
			: sessions.slice(0, MAP_ROWS);
	return { shown, hidden: sessions.length - shown.length };
}

interface Bubble {
	group: TopicGroup;
	shown: Session[];
	hidden: number;
	/** Extra lines under the focused row (its suggestion, its reply). */
	extras: string[];
	focusAt: number;
	h: number;
}

function focusExtras(input: MapInput): string[] {
	const out: string[] = [];
	if (input.focusSuggestion) out.push("suggestion");
	if (input.replyText !== null || input.focusElement === "reply")
		out.push("reply");
	return out;
}

function bubbleFor(group: TopicGroup, input: MapInput): Bubble {
	const { shown, hidden } = visibleRows(group.sessions, input.focusId);
	const focusAt = shown.findIndex((s) => s.id === input.focusId);
	const extras = focusAt >= 0 ? focusExtras(input) : [];
	return {
		group,
		shown,
		hidden,
		extras,
		focusAt,
		h: 2 + shown.length + extras.length + (hidden ? 1 : 0),
	};
}

export function drawMap(input: MapInput): MapLayout {
	const { width, height } = input;
	const canvas = new Canvas(width, height);
	const rows: CardBox[] = [];
	const bubbles: NodeBox[] = [];
	const links = new Links();

	const mw = Math.max(28, Math.min(48, Math.floor(width * 0.3)));
	const bw = Math.max(
		16,
		Math.min(MAX_BUBBLE_W, Math.floor((width - mw - GAP * 2 - 2) / 2)),
	);
	const left = Math.max(0, Math.floor((width - mw - 2 * (bw + GAP)) / 2));
	const mx = left + bw + GAP;
	// The input grows the box downward, so its top and the links stay put.
	const typed = input.master.inputText;
	const masterH =
		MASTER_H +
		(typed === null ? 0 : inputRows(typed, mw - 4 - PROMPT_W).length - 1);
	const my = Math.max(
		0,
		Math.min(Math.floor((height - MASTER_H) / 2), height - masterH),
	);
	const linkY = my + Math.floor(MASTER_H / 2);
	const sides = {
		left: { x: left, trunk: mx - 2, bubbles: [] as Bubble[], total: 0 },
		right: {
			x: mx + mw + GAP,
			trunk: mx + mw + 1,
			bubbles: [] as Bubble[],
			total: 0,
		},
	};

	// Neediest first, each into the shorter column; right wins a tie.
	for (const group of input.groups) {
		const bubble = bubbleFor(group, input);
		const side =
			sides.right.total <= sides.left.total ? sides.right : sides.left;
		side.total += (side.bubbles.length ? 1 : 0) + bubble.h;
		side.bubbles.push(bubble);
	}

	const drawBubbles: Array<() => void> = [];
	for (const [name, side] of Object.entries(sides)) {
		if (!side.bubbles.length) continue;
		const isRight = name === "right";
		// Centred on the master's link, or scrolled to the focused row.
		let y = 0;
		let focusY: number | null = null;
		const tops = side.bubbles.map((b) => {
			const top = y;
			if (b.focusAt >= 0) focusY = top + 1 + b.focusAt;
			y += b.h + 1;
			return top;
		});
		const total = side.total;
		const offset =
			total <= height
				? Math.max(0, Math.min(linkY - Math.floor(total / 2), height - total))
				: Math.min(
						0,
						Math.max(Math.floor(height / 2) - (focusY ?? 0), height - total),
					);

		const linkRows = tops.map((t) => t + offset + 1);
		const top = Math.min(linkY, ...linkRows);
		const bottom = Math.max(linkY, ...linkRows);
		if (isRight) links.horizontal(mx + mw, side.trunk, linkY);
		else links.horizontal(side.trunk, mx - 1, linkY);
		links.vertical(side.trunk, top, bottom);
		for (const row of linkRows) {
			if (isRight) links.horizontal(side.trunk, side.x - 2, row);
			else links.horizontal(side.x + bw + 1, side.trunk, row);
		}
		drawBubbles.push(() => {
			const dot = isRight ? side.x - 1 : side.x + bw;
			for (const row of linkRows) canvas.text(dot, row, "●", { fg: "magenta" });
			if (offset < 0) canvas.text(side.trunk, 0, "▲", { fg: "magenta" });
			if (total + offset > height)
				canvas.text(side.trunk, height - 1, "▼", { fg: "magenta" });
			side.bubbles.forEach((b, i) => {
				const y = (tops[i] as number) + offset;
				drawBubble(canvas, b, side.x, y, bw, input, rows);
				bubbles.push({ id: b.group.name, x: side.x, y, w: bw, h: b.h });
			});
		});
	}

	links.draw(canvas);
	for (const draw of drawBubbles) draw();
	drawMaster(canvas, mx, my, mw, masterH, input.master);
	return {
		canvas,
		rows,
		bubbles,
		master: { id: "", x: mx, y: my, w: mw, h: masterH },
	};
}

function drawBubble(
	canvas: Canvas,
	b: Bubble,
	x: number,
	top: number,
	w: number,
	input: MapInput,
	rows: CardBox[],
): void {
	const focused = b.focusAt >= 0;
	canvas.frame(
		x,
		top,
		w,
		b.h,
		focused ? "heavy" : "rounded",
		focused ? { fg: "whiteBright", bold: true } : DIM,
	);
	const chips = counts(b.group);
	const chipsW = chips.reduce((n, c) => n + [...c.text].length + 1, 0);
	let col = canvas.text(
		x + 2,
		top,
		` ${truncate(b.group.name, w - 7 - chipsW)}`,
		focused ? { fg: "whiteBright", bold: true } : { fg: "white" },
	);
	col = canvas.text(col, top, " · ", DIM);
	for (const c of chips) col = canvas.text(col, top, `${c.text} `, c.style);

	const inner = w - 4;
	let y = top + 1;
	b.shown.forEach((s, i) => {
		const focused = i === b.focusAt;
		const cursor = focused && (input.focusElement ?? "card") === "card";
		drawRow(canvas, s, x + 2, y, inner, cursor, focused);
		rows.push({ sessionId: s.id, x, y, w, h: 1 });
		y++;
		if (!focused) return;
		for (const extra of b.extras) {
			const cursor = input.focusElement === extra;
			if (cursor) canvas.text(x + 2, y, "▸", { fg: "whiteBright", bold: true });
			if (extra === "suggestion") {
				const chips = " y e n";
				const c = canvas.text(x + 4, y, "◆ ", { fg: "magenta" });
				canvas.text(
					c,
					y,
					truncate(input.focusSuggestion ?? "", inner - 4 - chips.length),
				);
				canvas.text(x + 2 + inner - chips.length, y, chips, DIM);
			} else {
				const text = input.replyText === null ? "› " : `› ${input.replyText}█`;
				canvas.fill(x + 4, y, inner - 2, 1, { bg: "black" });
				canvas.text(x + 4, y, truncate(text, inner - 2), {
					fg: "whiteBright",
					bg: "black",
				});
			}
			y++;
		}
	});
	if (b.hidden) canvas.text(x + 4, y, `+${b.hidden} more`, DIM);
}

/** One agent: cursor, glyph, name, ⚑. Waiting rows are inverse yellow. */
function drawRow(
	canvas: Canvas,
	s: Session,
	x: number,
	y: number,
	width: number,
	cursor: boolean,
	focused: boolean,
): void {
	const waiting = s.status === "waiting";
	const base: Style = waiting ? { fg: "black", bg: "yellow" } : {};
	if (waiting) canvas.fill(x, y, width, 1, base);
	if (cursor)
		canvas.text(x, y, "▸", {
			...base,
			fg: waiting ? "black" : "whiteBright",
			bold: true,
		});
	const g = glyph(s.status);
	let col = x + 2;
	if (g)
		col = canvas.text(col, y, `${g.ch} `, {
			...base,
			fg: waiting ? "black" : g.color,
			bold: true,
		});
	const flag = s.watched ? " ⚑" : "";
	col = canvas.text(col, y, truncate(s.name, x + width - col - flag.length), {
		...base,
		fg: waiting ? "black" : focused ? "whiteBright" : nameColor(s.status),
		bold: focused || waiting,
	});
	if (flag)
		canvas.text(col, y, flag, { ...base, fg: waiting ? "black" : "white" });
}

function drawMaster(
	canvas: Canvas,
	x: number,
	y: number,
	w: number,
	h: number,
	m: MapMaster,
): void {
	canvas.frame(
		x,
		y,
		w,
		h,
		m.focused ? "heavy" : "rounded",
		m.focused ? { fg: "whiteBright", bold: true } : { fg: "magenta" },
	);
	canvas.text(x + 2, y, " ◆ master ", { fg: "magenta", bold: true });
	if (m.thinking) canvas.text(x + w - 12, y, " thinking ", { fg: "magenta" });

	const ix = x + 2;
	const iw = w - 4;
	if (m.error) canvas.text(ix, y + 1, truncate(m.error, iw), { fg: "red" });
	else {
		const status =
			m.needCount > 0
				? `${m.needCount} ${m.needCount === 1 ? "thing needs" : "things need"} you`
				: "nothing needs you";
		const col = canvas.text(ix, y + 1, truncate(status, iw), {
			fg: m.needCount > 0 ? "yellow" : "gray",
		});
		const queued = ` · ${m.queueCount} queued`;
		const after =
			m.queueCount && [...queued].length <= ix + iw - col
				? canvas.text(col, y + 1, queued, { fg: QUEUE_COLOR })
				: col;
		const calm = ` · ${m.calmTopics} ${m.calmTopics === 1 ? "topic" : "topics"} calm`;
		// The calm count is a nicety; it shows only when it fits whole.
		if (m.calmTopics > 0 && [...calm].length <= ix + iw - after)
			canvas.text(after, y + 1, calm, DIM);
	}
	if (m.slackError)
		canvas.text(ix, y + 2, truncate(m.slackError, iw), { fg: "yellow" });

	const body = y + 3;
	const cursor = (row: number) =>
		canvas.text(x + 1, row, "▸", { fg: "whiteBright", bold: true });
	if (m.empty) {
		wrap(
			"No sessions yet. Press n to start your first session.",
			iw,
			3,
		).forEach((line, i) => {
			canvas.text(ix, body + i, line, DIM);
		});
	} else if (m.item?.kind === "permission") {
		cursor(body);
		canvas.text(
			ix,
			body,
			truncate(`◆ master wants to use ${m.item.permission.toolName}`, iw),
			{ fg: "whiteBright", bold: true },
		);
		canvas.text(
			ix + 2,
			body + 1,
			truncate(m.item.permission.detail, iw - 2),
			DIM,
		);
		canvas.text(ix + 2, body + 2, "y allow · n deny", DIM);
	} else if (m.item?.kind === "session") {
		const { session, suggestion, replyText } = m.item;
		cursor(body);
		const g = glyph(session.status);
		let col = ix;
		if (g) col = canvas.text(col, body, `${g.ch} `, { fg: g.color });
		col = canvas.text(col, body, truncate(session.name, ix + iw - col - 2), {
			fg: "whiteBright",
			bold: true,
		});
		if (session.watched) canvas.text(col, body, " ⚑", { fg: "white" });
		canvas.text(ix + 2, body + 1, truncate(askLine(session), iw - 2), DIM);
		if (replyText !== null) {
			canvas.fill(ix + 2, body + 2, iw - 2, 1, { bg: "black" });
			canvas.text(ix + 2, body + 2, truncate(`› ${replyText}█`, iw - 2), {
				fg: "whiteBright",
				bg: "black",
			});
		} else if (suggestion) {
			const chips = " y e n";
			const c = canvas.text(ix + 2, body + 2, "◆ ", { fg: "magenta" });
			canvas.text(c, body + 2, truncate(suggestion, iw - 4 - chips.length));
			canvas.text(ix + iw - chips.length, body + 2, chips, DIM);
		}
	} else if (m.item?.kind === "slack") {
		const { item, suggestion, replyText, now } = m.item;
		cursor(body);
		const when = age(item.at, now);
		let col = canvas.text(ix, body, "@ ", { fg: "yellow" });
		col = canvas.text(
			col,
			body,
			truncate(item.author, ix + iw - col - when.length - 1),
			{ fg: "whiteBright", bold: true },
		);
		canvas.text(
			col,
			body,
			truncate(
				item.reason === "dm" ? " · dm" : ` in ${item.channel}`,
				ix + iw - col - when.length - 1,
			),
			DIM,
		);
		canvas.text(ix + iw - when.length, body, when, DIM);
		canvas.text(ix + 2, body + 1, truncate(item.action, iw - 2), {
			fg: "white",
		});
		if (replyText !== null) {
			canvas.fill(ix + 2, body + 2, iw - 2, 1, { bg: "black" });
			const chars = [...`› ${replyText}█`];
			canvas.text(
				ix + 2,
				body + 2,
				chars.length > iw - 2
					? `…${chars.slice(-(iw - 3)).join("")}`
					: chars.join(""),
				{ fg: "whiteBright", bg: "black" },
			);
		} else if (suggestion) {
			const pending = suggestion.status === "pending";
			const chips = pending ? " y e n" : "";
			const d = canvas.text(ix + 2, body + 2, "◆ ", { fg: "magenta" });
			const c = canvas.text(d, body + 2, "slack ", { fg: SLACK_COLOR });
			canvas.text(
				c,
				body + 2,
				truncate(
					suggestion.status === "sending"
						? "Sending to Slack…"
						: suggestion.label,
					iw - 10 - chips.length,
				),
				pending ? {} : DIM,
			);
			if (chips) canvas.text(ix + iw - chips.length, body + 2, chips, DIM);
		}
	} else if (m.item?.kind === "queued") {
		const { session, text, replyText } = m.item;
		cursor(body);
		const chips = " y e n";
		const col = canvas.text(ix, body, "→ ", { fg: QUEUE_COLOR });
		canvas.text(
			col,
			body,
			truncate(session.name, ix + iw - col - chips.length),
			{
				fg: "whiteBright",
				bold: true,
			},
		);
		canvas.text(ix + iw - chips.length, body, chips, DIM);
		if (replyText !== null) {
			canvas.fill(ix + 2, body + 1, iw - 2, 1, { bg: "black" });
			canvas.text(ix + 2, body + 1, truncate(`› ${replyText}█`, iw - 2), {
				fg: "whiteBright",
				bg: "black",
			});
		} else
			wrap(text, iw - 2, 2).forEach((line, i) => {
				canvas.text(ix + 2, body + 1 + i, line, { fg: "white" });
			});
	} else if (m.lastMessage) {
		const you = m.lastMessage.from === "you";
		canvas.text(ix, body, you ? "you" : "◆", { fg: you ? "cyan" : "magenta" });
		wrap(m.lastMessage.text, iw - 4, 3).forEach((line, i) => {
			canvas.text(ix + 4, body + i, line, you ? {} : { fg: "white" });
		});
	} else {
		canvas.text(ix, body, truncate("Press i to ask the master.", iw), DIM);
	}

	const inputRow = y + MASTER_H - 2;
	const typed = m.inputText;
	const rows = typed === null ? [] : inputRows(typed, iw - PROMPT_W);
	const lines = Math.max(1, rows.length);
	if (m.inputSelected) cursor(inputRow);
	canvas.fill(ix, inputRow, iw, lines, { bg: "black" });
	const col = canvas.text(ix, inputRow, "› ", { fg: "magenta", bg: "black" });
	if (typed === null)
		canvas.text(col, inputRow, truncate("message master…", iw - 2), {
			fg: "gray",
			bg: "black",
		});
	else
		rows.forEach((row, i) => {
			canvas.text(ix + PROMPT_W, inputRow + i, row, {
				fg: "whiteBright",
				bg: "black",
			});
		});

	// The @ list sits on the rows just above the input, over the panel's body.
	const names = m.mentions?.names ?? [];
	names.forEach((name, i) => {
		const row = inputRow - names.length + i;
		const on = i === m.mentions?.selected;
		canvas.fill(ix, row, iw, 1, { bg: "black" });
		canvas.text(ix, row, truncate(`${on ? "▸ " : "  "}@${name}`, iw), {
			fg: on ? "whiteBright" : "white",
			bold: on,
			bg: "black",
		});
	});
}

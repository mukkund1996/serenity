import {
	Canvas,
	type PrTone,
	prStatus,
	type Session,
	type Style,
	type TopicGroup,
	truncate,
	wrap,
} from "@serenity/core";
import { cardText, frameColor, glyph, nameColor } from "./theme";

/**
 * Draws one side of the topics zoom (design screen 2): every topic as a
 * bubble of 40-col cards, neediest first, side by side in shelves that fill
 * the width, all linked back to the master at the inner edge (the left edge
 * of the right side, the right edge of the left side, ADR 0027). When they
 * don't fit, the shelves scroll to the focused card.
 */

export const CARD_W = 40;
/** Text rows under a card's PR line: as many as its text needs, up to 4. */
const BODY_MAX = 4;
const CARD_INNER = CARD_W - 4;
const CARD_GAP_X = 4;
const CARD_GAP_Y = 1;
const PAD_X = 3;
const TRUNK_X = 2;
const BUBBLE_X = 5;
const BUBBLE_GAP_X = 5;
/** Blank rows between a shelf's bubbles and the next shelf's bus. */
const SHELF_GAP_Y = 1;
/** The narrowest side that still fits a one-card bubble. */
export const SIDE_MIN_W = BUBBLE_X + CARD_W + PAD_X * 2 + 1;

export interface CardBox {
	sessionId: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface TopicsInput {
	width: number;
	height: number;
	/** Canvas row where the master's link leaves the panel. */
	masterRow: number;
	groups: TopicGroup[];
	focusId: string | null;
	/** The element selected inside the focused card (arrow keys). */
	focusElement?: CardElement;
	/** The master's suggestion for the focused card, shown above its input row. */
	focusSuggestion?: string | null;
	/** Text being typed into the focused card's input row, or null when not replying. */
	replyText: string | null;
	/** Which side of the master this canvas sits on; the master is at its inner edge. Default right. */
	side?: "left" | "right";
}

/** What the arrow keys step through on a focused card; `card` is the card itself. */
export type CardElement = "card" | "pr" | "suggestion" | "reply";

export function cardElements(hasSuggestion: boolean): CardElement[] {
	return hasSuggestion
		? ["card", "pr", "suggestion", "reply"]
		: ["card", "pr", "reply"];
}

/** Frame, PR line and text; a focused card adds its suggestion and input rows. */
function cardHeight(
	s: Session,
	focused: boolean,
	suggestion: string | null,
): number {
	const body = Math.max(1, cardBody(s, CARD_INNER).length);
	return 3 + body + (focused ? 1 + (suggestion ? 1 : 0) : 0);
}

export interface TopicsLayout {
	canvas: Canvas;
	cards: CardBox[];
}

export const DIM: Style = { fg: "gray" };
const LINK: Style = { fg: "magenta", dim: true };

/** Direction bits for link cells, resolved to box-drawing junctions at the end. */
const N = 1;
const S = 2;
const W = 4;
const E = 8;
const JUNCTIONS: Record<number, string> = {
	[E | W]: "─",
	[E]: "─",
	[W]: "─",
	[N | S]: "│",
	[N]: "│",
	[S]: "│",
	[S | E]: "┌",
	[S | W]: "┐",
	[N | E]: "└",
	[N | W]: "┘",
	[N | S | E]: "├",
	[N | S | W]: "┤",
	[S | E | W]: "┬",
	[N | E | W]: "┴",
	[N | S | E | W]: "┼",
};

/** Right-angle links from the master, merged into box-drawing junctions. */
export class Links {
	private readonly cells = new Map<string, number>();

	private add(x: number, y: number, bits: number): void {
		const key = `${x},${y}`;
		this.cells.set(key, (this.cells.get(key) ?? 0) | bits);
	}

	horizontal(x1: number, x2: number, y: number): void {
		for (let x = x1; x <= x2; x++)
			this.add(x, y, (x > x1 ? W : 0) | (x < x2 ? E : 0));
	}

	vertical(x: number, y1: number, y2: number): void {
		for (let y = y1; y <= y2; y++)
			this.add(x, y, (y > y1 ? N : 0) | (y < y2 ? S : 0));
	}

	draw(canvas: Canvas): void {
		for (const [key, bits] of this.cells) {
			const [x, y] = key.split(",").map(Number) as [number, number];
			canvas.text(x, y, JUNCTIONS[bits] ?? "─", LINK);
		}
	}
}

/** A topic label's counts: `◐1 ●5 ✓1`, or `quiet`. */
export function counts(
	group: TopicGroup,
): Array<{ text: string; style: Style }> {
	const out: Array<{ text: string; style: Style }> = [];
	if (group.counts.waiting)
		out.push({ text: `◐${group.counts.waiting}`, style: { fg: "yellow" } });
	if (group.counts.working)
		out.push({ text: `●${group.counts.working}`, style: { fg: "blue" } });
	if (group.counts.done)
		out.push({ text: `✓${group.counts.done}`, style: { fg: "green" } });
	if (!out.length) out.push({ text: "quiet", style: DIM });
	return out;
}

type Line = Array<{ text: string; style: Style }>;

/** "label text", cut to `width` columns. */
function labelled(
	label: string,
	text: string,
	labelStyle: Style,
	textStyle: Style,
	width: number,
): Line {
	return [
		{ text: label, style: labelStyle },
		{ text: truncate(text, width - [...label].length), style: textStyle },
	];
}

/** "label text" wrapped to `lines` rows, the label leading the first. */
function labelledLines(
	label: string,
	text: string,
	labelStyle: Style,
	textStyle: Style,
	width: number,
	lines: number,
): Line[] {
	const n = [...label].length;
	return wrap(`${label}${text}`, width, lines).map(
		(t, i): Line =>
			i === 0
				? [
						{ text: label, style: labelStyle },
						{ text: [...t].slice(n).join(""), style: textStyle },
					]
				: [{ text: t, style: textStyle }],
	);
}

/**
 * The card's text, up to BODY_MAX rows and no more than it needs: the
 * master's summary, or until there is one the latest exchange in order:
 * your prompt, then Claude's reply, or what it is doing now.
 */
function cardBody(s: Session, width: number): Line[] {
	const plain = (text: string) =>
		wrap(text, width, BODY_MAX).map((t): Line => [{ text: t, style: DIM }]);
	if (s.summary || !s.lastPrompt) return plain(cardText(s));
	const you = labelled(
		"you › ",
		`"${s.lastPrompt}"`,
		{ fg: "cyan" },
		{ fg: "white" },
		width,
	);
	if (s.status === "waiting")
		return [
			you,
			...wrap(s.ask ?? "needs you", width, BODY_MAX - 1).map(
				(t): Line => [{ text: t, style: { fg: "yellow" } }],
			),
		];
	if (s.status === "working")
		return [you, [{ text: "working…", style: { fg: "blue" } }]];
	if (s.status === "dead")
		return [
			you,
			[
				{
					text: s.pinned ? "Ended. Enter resumes it." : "Session ended.",
					style: DIM,
				},
			],
		];
	if (s.lastAssistantMessage)
		return [
			you,
			...labelledLines(
				"claude › ",
				s.lastAssistantMessage,
				DIM,
				{ fg: "white" },
				width,
				BODY_MAX - 1,
			),
		];
	return [you];
}

const TONE: Record<PrTone, Style> = {
	merged: { fg: "cyan" },
	good: { fg: "green" },
	bad: { fg: "red" },
	warn: { fg: "yellow" },
	quiet: { fg: "gray" },
};

/** Card row 1 (design): "PR #482 checks passing", "no PR yet", or why it is unknown. */
function drawPrLine(
	canvas: Canvas,
	s: Session,
	x: number,
	y: number,
	width: number,
): void {
	if (s.pr) {
		const status = prStatus(s.pr);
		let col = canvas.text(x, y, "PR ", { fg: "gray" });
		col = canvas.text(col, y, `#${s.pr.number}`, { underline: true });
		canvas.text(
			col,
			y,
			truncate(` ${status.text}`, width - (col - x)),
			TONE[status.tone],
		);
	} else if (s.prError) {
		canvas.text(x, y, truncate(`PR unknown · ${s.prError}`, width), {
			fg: "gray",
			dim: true,
		});
	} else {
		canvas.text(x, y, "no PR yet", { fg: "gray", dim: true });
	}
}

interface CardFocus {
	element: CardElement;
	suggestion: string | null;
	replyText: string | null;
}

function drawCard(
	canvas: Canvas,
	s: Session,
	x: number,
	y: number,
	focus: CardFocus | null,
): number {
	const focused = focus !== null;
	const h = cardHeight(s, focused, focus?.suggestion ?? null);
	canvas.frame(x, y, CARD_W, h, focused ? "heavy" : "light", {
		fg: frameColor(s.status, focused),
		bold: focused,
		dim: !focused,
	});

	const g = glyph(s.status);
	let col = canvas.text(x + 1, y, " ");
	if (g)
		col = canvas.text(col, y, `${g.ch} `, {
			fg: g.color,
			bold: focused,
			dim: !focused,
		});
	col = canvas.text(col, y, truncate(s.name, CARD_W - 18), {
		fg: focused ? "whiteBright" : nameColor(s.status),
		bold: true,
	});
	canvas.text(col, y, " ");

	const chips: Array<{ text: string; style: Style }> = [];
	if (s.origin === "adopted") chips.push({ text: " ↗ ", style: DIM });
	if (s.watched) chips.push({ text: " ⚑ ", style: { fg: "white" } });
	if (s.status === "waiting")
		chips.push({
			text: " WAITING ",
			style: { fg: "black", bg: "yellow", bold: true },
		});
	let right = x + CARD_W - 2;
	for (const chip of chips.reverse()) {
		right -= [...chip.text].length;
		canvas.text(right, y, chip.text, chip.style);
	}

	const inner = CARD_INNER;
	const body = cardBody(s, inner);
	drawPrLine(canvas, s, x + 2, y + 1, inner);
	body.forEach((line, i) => {
		let at = x + 2;
		for (const run of line)
			at = canvas.text(at, y + 2 + i, run.text, run.style);
	});
	if (!focus) return h;
	const cursor = (row: number) =>
		canvas.text(x + 1, row, "▸", { fg: "whiteBright", bold: true });
	if (focus.element === "pr") cursor(y + 1);
	let inputRow = y + 2 + Math.max(1, body.length);
	if (focus.suggestion) {
		const chips = " y e n";
		let col = canvas.text(x + 2, inputRow, "◆ ", { fg: "magenta" });
		col = canvas.text(
			col,
			inputRow,
			truncate(focus.suggestion, inner - 2 - chips.length),
		);
		canvas.text(x + 2 + inner - chips.length, inputRow, chips, DIM);
		if (focus.element === "suggestion") cursor(inputRow);
		inputRow++;
	}
	const input = focus.replyText === null ? "› " : `› ${focus.replyText}█`;
	canvas.fill(x + 2, inputRow, inner, 1, { bg: "black" });
	canvas.text(x + 2, inputRow, truncate(input, inner), {
		fg: "whiteBright",
		bg: "black",
	});
	if (focus.element === "reply") cursor(inputRow);
	return h;
}

interface Placed {
	group: TopicGroup;
	cols: number;
	rowHeights: number[];
	x: number;
	w: number;
	h: number;
}

export function drawTopics(input: TopicsInput): TopicsLayout {
	const canvas = new Canvas(input.width, input.height);
	const cards: CardBox[] = [];
	const links = new Links();

	// Shelves are laid out by distance from the master's edge; on the left
	// side the canvas is mirrored, so bubbles grow leftwards from it.
	const mirrored = input.side === "left";
	const xOf = (dist: number, w: number) =>
		mirrored ? input.width - dist - w : dist;
	const trunkX = xOf(TRUNK_X, 1);
	const right = input.width - 1;
	const room = right - BUBBLE_X - PAD_X * 2 + CARD_GAP_X;
	const maxCols = Math.max(1, Math.floor(room / (CARD_W + CARD_GAP_X)));

	// Bubbles fill shelves left to right, neediest first, so the canvas's
	// width is used: each goes on the first shelf with room for it. A shelf
	// hangs off a bus on the row above it, linked to the trunk and from
	// there to the master.
	const shelves: Placed[][] = [];
	const ends: number[] = [];
	for (const group of input.groups) {
		const cols = Math.min(maxCols, group.sessions.length);
		const rowHeights: number[] = [];
		group.sessions.forEach((s, i) => {
			const row = Math.floor(i / cols);
			const h = cardHeight(
				s,
				s.id === input.focusId,
				input.focusSuggestion ?? null,
			);
			rowHeights[row] = Math.max(rowHeights[row] ?? 0, h);
		});
		const cardsH =
			rowHeights.reduce((a, b) => a + b, 0) +
			Math.max(0, rowHeights.length - 1) * CARD_GAP_Y;
		const w = cols * CARD_W + (cols - 1) * CARD_GAP_X + PAD_X * 2;
		let shelf = ends.findIndex((end) => end + w <= right);
		if (shelf < 0) {
			shelf = shelves.push([]) - 1;
			ends.push(BUBBLE_X);
		}
		const dist = ends[shelf] as number;
		(shelves[shelf] as Placed[]).push({
			group,
			cols,
			rowHeights,
			x: xOf(dist, w),
			w,
			h: 2 + 1 + cardsH + 1,
		});
		ends[shelf] = dist + w + BUBBLE_GAP_X;
	}

	// Laid out from row 0, then shifted to centre on the master's row, or on
	// the focused card when the stack is taller than the canvas.
	const busRows: number[] = [];
	const tops: number[] = [];
	let focusMid: number | null = null;
	let y = 0;
	for (const shelf of shelves) {
		busRows.push(y);
		tops.push(y + 1);
		for (const b of shelf) {
			const at = b.group.sessions.findIndex((s) => s.id === input.focusId);
			if (at < 0) continue;
			const row = Math.floor(at / b.cols);
			const above = b.rowHeights
				.slice(0, row)
				.reduce((a, h) => a + h + CARD_GAP_Y, 0);
			focusMid = y + 3 + above + Math.floor((b.rowHeights[row] ?? 0) / 2);
		}
		y += 1 + Math.max(...shelf.map((b) => b.h)) + SHELF_GAP_Y;
	}

	const total = Math.max(0, y - SHELF_GAP_Y);
	const centre = focusMid ?? 0;
	const offset =
		total <= input.height
			? Math.max(
					0,
					Math.min(
						input.masterRow - Math.floor(total / 2),
						input.height - total,
					),
				)
			: Math.min(
					0,
					Math.max(Math.floor(input.height / 2) - centre, input.height - total),
				);

	if (shelves.length > 0) {
		const buses = busRows.map((r) => r + offset);
		const top = Math.min(input.masterRow, ...buses);
		const bottom = Math.max(input.masterRow, ...buses);
		if (mirrored) links.horizontal(trunkX, right, input.masterRow);
		else links.horizontal(0, trunkX, input.masterRow);
		links.vertical(trunkX, top, bottom);
		shelves.forEach((shelf, i) => {
			const bus = buses[i] as number;
			const drops = shelf.map((b) => b.x + 1);
			if (mirrored) links.horizontal(Math.min(...drops), trunkX, bus);
			else links.horizontal(trunkX, Math.max(...drops), bus);
			for (const d of drops) links.vertical(d, bus, bus + 1);
		});
		links.draw(canvas);
	}
	if (offset < 0) canvas.text(trunkX, 0, "▲", { fg: "magenta" });
	if (total + offset > input.height)
		canvas.text(trunkX, input.height - 1, "▼", { fg: "magenta" });

	// Bubbles are drawn after their links so frames win where they meet.
	shelves.forEach((shelf, i) => {
		for (const b of shelf)
			drawBubble(canvas, b, (tops[i] as number) + offset, input, cards);
	});

	return { canvas, cards };
}

function drawBubble(
	canvas: Canvas,
	b: Placed,
	top: number,
	input: TopicsInput,
	cards: CardBox[],
): void {
	canvas.frame(b.x, top, b.w, b.h, "rounded", DIM);
	canvas.text(b.x + 1, top, "●", { fg: "magenta" });
	let col = canvas.text(b.x + 2, top, ` ${b.group.name}`, { fg: "white" });
	col = canvas.text(col, top, " · ", DIM);
	for (const c of counts(b.group))
		col = canvas.text(col, top, `${c.text} `, c.style);
	let rowY = top + 2;
	b.rowHeights.forEach((rowH, row) => {
		for (let c = 0; c < b.cols; c++) {
			const s = b.group.sessions[row * b.cols + c];
			if (!s) continue;
			const cx = b.x + PAD_X + c * (CARD_W + CARD_GAP_X);
			const h = drawCard(
				canvas,
				s,
				cx,
				rowY,
				s.id === input.focusId
					? {
							element: input.focusElement ?? "card",
							suggestion: input.focusSuggestion ?? null,
							replyText: input.replyText,
						}
					: null,
			);
			cards.push({ sessionId: s.id, x: cx, y: rowY, w: CARD_W, h });
		}
		rowY += rowH + CARD_GAP_Y;
	});
}

/**
 * Splits topics between the two sides of a centred master (ADR 0027),
 * neediest first, each to the side with fewer cards; right wins a tie, so
 * the neediest topic sits right of the master.
 */
export function splitSides(groups: TopicGroup[]): {
	left: TopicGroup[];
	right: TopicGroup[];
} {
	const left: TopicGroup[] = [];
	const right: TopicGroup[] = [];
	let leftCards = 0;
	let rightCards = 0;
	for (const g of groups) {
		if (rightCards <= leftCards) {
			right.push(g);
			rightCards += g.sessions.length;
		} else {
			left.push(g);
			leftCards += g.sessions.length;
		}
	}
	return { left, right };
}

/** First card of the next (`step` 1) or previous (-1) topic, wrapping around. */
export function stepTopic(
	groups: TopicGroup[],
	fromId: string | null,
	step: 1 | -1,
): string | null {
	if (!groups.length) return null;
	const at = groups.findIndex((g) => g.sessions.some((s) => s.id === fromId));
	const next = at < 0 ? 0 : (at + step + groups.length) % groups.length;
	return groups[next]?.sessions[0]?.id ?? null;
}

/** A focusable box on the map: a card, or the master panel. */
export interface NodeBox {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * Spatial focus movement between nodes (WASD). A node counts as ahead only
 * when it lies wholly past the current one, so the full-height master panel
 * is reached with A and left with D, never with W or S.
 */
export function moveFocus(
	nodes: NodeBox[],
	fromId: string | null,
	dir: "up" | "down" | "left" | "right",
): string | null {
	const from = nodes.find((c) => c.id === fromId);
	if (!from) return nodes[0]?.id ?? null;
	const cx = from.x + from.w / 2;
	const cy = from.y + from.h / 2;
	let best: NodeBox | null = null;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const c of nodes) {
		if (c === from) continue;
		const past =
			dir === "up"
				? c.y + c.h <= from.y
				: dir === "down"
					? c.y >= from.y + from.h
					: dir === "left"
						? c.x + c.w <= from.x
						: c.x >= from.x + from.w;
		if (!past) continue;
		const dx = c.x + c.w / 2 - cx;
		const dy = c.y + c.h / 2 - cy;
		const ahead =
			dir === "up" ? -dy : dir === "down" ? dy : dir === "left" ? -dx : dx;
		const sideways =
			dir === "up" || dir === "down" ? Math.abs(dx) : Math.abs(dy);
		const score = ahead + sideways * 2;
		if (score < bestScore) {
			bestScore = score;
			best = c;
		}
	}
	return best?.id ?? from.id;
}

/**
 * Keeps the topic that holds focus in the order it was last drawn, so
 * cards do not move under the cursor; new cards join at the end. Other
 * topics take their fresh order (waiting, in progress, finished).
 */
export function holdOrder(
	groups: TopicGroup[],
	drawn: Map<string, string[]>,
	held: string | null,
): TopicGroup[] {
	const before = held ? drawn.get(held) : undefined;
	if (!before) return groups;
	const at = (s: Session) => {
		const i = before.indexOf(s.id);
		return i === -1 ? before.length : i;
	};
	return groups.map((g) =>
		g.name === held
			? { ...g, sessions: [...g.sessions].sort((a, b) => at(a) - at(b)) }
			: g,
	);
}

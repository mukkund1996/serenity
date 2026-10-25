import {
	Canvas,
	type CategoryGroup,
	type PrTone,
	prStatus,
	type Session,
	type Style,
	truncate,
	wrap,
} from "@serenity/core";
import { cardText, glyph, nameColor } from "./theme";

/**
 * Draws the topics zoom's right-hand side (design screen 2): the two
 * categories that need the most attention as bubbles of 40-col cards, the
 * rest in a dashed node, all linked back to the master on the left edge.
 */

export const CARD_W = 40;
const CARD_H = 5;
const FOCUSED_CARD_H = 6;
const CARD_GAP_X = 2;
const PAD_X = 3;
const TRUNK_X = 2;
const BUBBLE_X = 6;
const MAX_CATEGORIES = 2;
const MAX_CARDS = 3;
const NODE_W = 50;

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
	groups: CategoryGroup[];
	focusId: string | null;
	/** Text being typed into the focused card's input row, or null when not replying. */
	replyText: string | null;
}

export interface TopicsLayout {
	canvas: Canvas;
	cards: CardBox[];
}

const DIM: Style = { fg: "gray" };
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

class Links {
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

function counts(group: CategoryGroup): Array<{ text: string; style: Style }> {
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

/**
 * The card's two text rows. Until the master writes summaries (milestone 2)
 * they show the latest exchange in order: your prompt, then Claude's reply,
 * or what it is doing now.
 */
function cardBody(s: Session, width: number): Line[] {
	const plain = (text: string) =>
		wrap(text, width, 2).map((t): Line => [{ text: t, style: DIM }]);
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
			[
				{
					text: truncate(s.ask ?? "needs you", width),
					style: { fg: "yellow" },
				},
			],
		];
	if (s.status === "working")
		return [you, [{ text: "working…", style: { fg: "blue" } }]];
	if (s.status === "dead")
		return [you, [{ text: "Session ended.", style: DIM }]];
	if (s.lastAssistantMessage)
		return [
			you,
			labelled(
				"claude › ",
				s.lastAssistantMessage,
				DIM,
				{ fg: "white" },
				width,
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

function drawCard(
	canvas: Canvas,
	s: Session,
	x: number,
	y: number,
	focused: boolean,
	replyText: string | null,
): number {
	const h = focused ? FOCUSED_CARD_H : CARD_H;
	const frameStyle: Style = focused
		? { fg: "whiteBright", bold: true }
		: s.status === "waiting"
			? { fg: "yellow" }
			: DIM;
	canvas.frame(x, y, CARD_W, h, focused ? "heavy" : "light", frameStyle);

	const g = glyph(s.status);
	let col = canvas.text(x + 1, y, " ");
	if (g) col = canvas.text(col, y, `${g.ch} `, { fg: g.color, bold: true });
	col = canvas.text(col, y, truncate(s.name, CARD_W - 18), {
		fg: focused ? "whiteBright" : nameColor(s.status),
		bold: true,
	});
	canvas.text(col, y, " ");

	const chips: Array<{ text: string; style: Style }> = [];
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

	const inner = CARD_W - 4;
	drawPrLine(canvas, s, x + 2, y + 1, inner);
	cardBody(s, inner).forEach((line, i) => {
		let at = x + 2;
		for (const run of line)
			at = canvas.text(at, y + 2 + i, run.text, run.style);
	});
	if (focused) {
		const input = replyText === null ? "› " : `› ${replyText}█`;
		canvas.fill(x + 2, y + 4, inner, 1, { bg: "black" });
		canvas.text(x + 2, y + 4, truncate(input, inner), {
			fg: "whiteBright",
			bg: "black",
		});
	}
	return h;
}

export function drawTopics(input: TopicsInput): TopicsLayout {
	const canvas = new Canvas(input.width, input.height);
	const cards: CardBox[] = [];
	const links = new Links();
	const linkRows: number[] = [];

	const visible = input.groups.slice(0, MAX_CATEGORIES);
	const hidden = input.groups.slice(MAX_CATEGORIES);
	const room = input.width - BUBBLE_X - 1 - PAD_X * 2 + CARD_GAP_X;
	const maxCols = Math.max(1, Math.floor(room / (CARD_W + CARD_GAP_X)));

	// Bubbles are drawn after their links so frames win where they meet.
	const drawBubbles: Array<() => void> = [];
	// Laid out from row 0, then shifted so the stack centres on the master's row.
	let offset = 0;
	let y = 0;
	for (const group of visible) {
		const shown = group.sessions.slice(0, MAX_CARDS);
		const more = group.sessions.length - shown.length;
		const cols = Math.min(maxCols, shown.length);
		const rowHeights: number[] = [];
		shown.forEach((s, i) => {
			const row = Math.floor(i / cols);
			const h = s.id === input.focusId ? FOCUSED_CARD_H : CARD_H;
			rowHeights[row] = Math.max(rowHeights[row] ?? 0, h);
		});
		const cardsH =
			rowHeights.reduce((a, b) => a + b, 0) +
			Math.max(0, rowHeights.length - 1);
		const bubbleW = cols * CARD_W + (cols - 1) * CARD_GAP_X + PAD_X * 2;
		const bubbleH = 2 + 1 + cardsH + 1 + (more > 0 ? 1 : 0);
		const rel = y;
		linkRows.push(rel + 2);
		drawBubbles.push(() => {
			const top = rel + offset;
			canvas.frame(BUBBLE_X, top, bubbleW, bubbleH, "rounded", DIM);
			let col = canvas.text(BUBBLE_X + 2, top, ` ${group.name}`, {
				fg: "white",
			});
			col = canvas.text(col, top, " · ", DIM);
			for (const c of counts(group))
				col = canvas.text(col, top, `${c.text} `, c.style);
			let rowY = top + 2;
			rowHeights.forEach((rowH, row) => {
				for (let c = 0; c < cols; c++) {
					const s = shown[row * cols + c];
					if (!s) continue;
					const cx = BUBBLE_X + PAD_X + c * (CARD_W + CARD_GAP_X);
					const focused = s.id === input.focusId;
					const h = drawCard(
						canvas,
						s,
						cx,
						rowY,
						focused,
						focused ? input.replyText : null,
					);
					cards.push({ sessionId: s.id, x: cx, y: rowY, w: CARD_W, h });
				}
				rowY += rowH + 1;
			});
			if (more > 0)
				canvas.text(BUBBLE_X + PAD_X, rowY - 1, `+${more} more`, {
					fg: "white",
				});
		});
		y += bubbleH + 1;
	}

	if (hidden.length > 0) {
		const rel = y;
		const h = hidden.length + 2;
		linkRows.push(rel + 1);
		y += h + 1;
		drawBubbles.push(() => {
			const top = rel + offset;
			canvas.frame(BUBBLE_X, top, NODE_W, h, "dashed", DIM);
			canvas.text(
				BUBBLE_X + 2,
				top,
				` ${hidden.length} more ${hidden.length === 1 ? "category" : "categories"} `,
				{
					fg: "white",
				},
			);
			hidden.forEach((group, i) => {
				const row = top + 1 + i;
				canvas.text(BUBBLE_X + 2, row, truncate(group.name, 13));
				let col = BUBBLE_X + 16;
				for (const c of counts(group))
					col = canvas.text(col, row, `${c.text} `, c.style);
			});
		});
	}

	const total = Math.max(0, y - 1);
	offset = Math.max(
		0,
		Math.min(input.masterRow - Math.floor(total / 2), input.height - total),
	);
	for (let i = 0; i < linkRows.length; i++)
		linkRows[i] = (linkRows[i] as number) + offset;

	if (linkRows.length > 0) {
		const top = Math.min(input.masterRow, ...linkRows);
		const bottom = Math.max(input.masterRow, ...linkRows);
		links.horizontal(0, TRUNK_X, input.masterRow);
		links.vertical(TRUNK_X, top, bottom);
		for (const row of linkRows) links.horizontal(TRUNK_X, BUBBLE_X - 2, row);
		links.draw(canvas);
		for (const row of linkRows)
			canvas.text(BUBBLE_X - 1, row, "●", { fg: "magenta" });
	}
	for (const draw of drawBubbles) draw();

	return { canvas, cards };
}

/** Spatial focus movement between card boxes (WASD). */
export function moveFocus(
	cards: CardBox[],
	fromId: string | null,
	dir: "up" | "down" | "left" | "right",
): string | null {
	const from = cards.find((c) => c.sessionId === fromId);
	if (!from) return cards[0]?.sessionId ?? null;
	const cx = from.x + from.w / 2;
	const cy = from.y + from.h / 2;
	let best: CardBox | null = null;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const c of cards) {
		if (c === from) continue;
		const dx = c.x + c.w / 2 - cx;
		const dy = c.y + c.h / 2 - cy;
		const ahead =
			dir === "up" ? -dy : dir === "down" ? dy : dir === "left" ? -dx : dx;
		if (ahead <= 0) continue;
		const sideways =
			dir === "up" || dir === "down" ? Math.abs(dx) : Math.abs(dy);
		const score = ahead + sideways * 2;
		if (score < bestScore) {
			bestScore = score;
			best = c;
		}
	}
	return best?.sessionId ?? from.sessionId;
}

/**
 * A grid of terminal cells (ADR 0003). The map and topics zooms draw bubbles,
 * cards and links into it; the TUI turns rows of runs into Ink <Text>.
 */

export type Color =
	| "default"
	| "black"
	| "red"
	| "green"
	| "yellow"
	| "blue"
	| "magenta"
	| "cyan"
	| "white"
	| "gray"
	| "whiteBright"
	| "yellowBright"
	| "blueBright"
	| "magentaBright"
	| "greenBright"
	/** A truecolor hex, for the few colours the named ones lack. */
	| `#${string}`;

export interface Style {
	fg?: Color;
	bg?: Color;
	bold?: boolean;
	dim?: boolean;
	underline?: boolean;
}

interface Cell {
	ch: string;
	style: Style;
}

export interface Run {
	text: string;
	style: Style;
}

export type FrameKind = "light" | "heavy" | "rounded" | "dashed" | "double";

const FRAMES: Record<
	FrameKind,
	{ tl: string; tr: string; bl: string; br: string; h: string; v: string }
> = {
	light: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
	heavy: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" },
	rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
	dashed: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "╌", v: "╎" },
	double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
};

const EMPTY: Style = {};

function sameStyle(a: Style, b: Style): boolean {
	return (
		a.fg === b.fg &&
		a.bg === b.bg &&
		!!a.bold === !!b.bold &&
		!!a.dim === !!b.dim &&
		!!a.underline === !!b.underline
	);
}

export class Canvas {
	private readonly cells: Cell[][];

	constructor(
		readonly width: number,
		readonly height: number,
	) {
		this.cells = Array.from({ length: height }, () =>
			Array.from({ length: width }, () => ({ ch: " ", style: EMPTY })),
		);
	}

	/** Writes text left to right, clipped to the canvas. Returns the column after the text. */
	text(x: number, y: number, text: string, style: Style = EMPTY): number {
		const row = this.cells[y];
		let col = x;
		for (const ch of text) {
			if (row && col >= 0 && col < this.width) row[col] = { ch, style };
			col++;
		}
		return col;
	}

	fill(x: number, y: number, w: number, h: number, style: Style = EMPTY): void {
		for (let row = y; row < y + h; row++)
			this.text(x, row, " ".repeat(Math.max(0, w)), style);
	}

	hline(
		x: number,
		y: number,
		length: number,
		ch = "─",
		style: Style = EMPTY,
	): void {
		this.text(x, y, ch.repeat(Math.max(0, length)), style);
	}

	vline(
		x: number,
		y: number,
		length: number,
		ch = "│",
		style: Style = EMPTY,
	): void {
		for (let row = y; row < y + length; row++) this.text(x, row, ch, style);
	}

	/** Draws a frame and clears its inside. */
	frame(
		x: number,
		y: number,
		w: number,
		h: number,
		kind: FrameKind,
		style: Style = EMPTY,
	): void {
		if (w < 2 || h < 2) return;
		const f = FRAMES[kind];
		this.fill(x + 1, y + 1, w - 2, h - 2);
		this.text(x, y, f.tl + f.h.repeat(w - 2) + f.tr, style);
		this.text(x, y + h - 1, f.bl + f.h.repeat(w - 2) + f.br, style);
		this.vline(x, y + 1, h - 2, f.v, style);
		this.vline(x + w - 1, y + 1, h - 2, f.v, style);
	}

	rows(): Run[][] {
		return this.cells.map((row) => {
			const runs: Run[] = [];
			for (const cell of row) {
				const last = runs[runs.length - 1];
				if (last && sameStyle(last.style, cell.style)) last.text += cell.ch;
				else runs.push({ text: cell.ch, style: cell.style });
			}
			return runs;
		});
	}

	/** Plain text, for tests. */
	toString(): string {
		return this.cells
			.map((row) =>
				row
					.map((c) => c.ch)
					.join("")
					.trimEnd(),
			)
			.join("\n");
	}
}

/** Cuts text to `width` columns, adding … when it is cut. */
export function truncate(text: string, width: number): string {
	const chars = [...text];
	if (chars.length <= width) return text;
	if (width <= 1) return chars.slice(0, width).join("");
	return `${chars.slice(0, width - 1).join("")}…`;
}

/** Greedy word wrap into at most `maxLines` lines; the last line is truncated. */
export function wrap(text: string, width: number, maxLines: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let line = "";
	for (let i = 0; i < words.length; i++) {
		const word = words[i] as string;
		const candidate = line ? `${line} ${word}` : word;
		if ([...candidate].length <= width) {
			line = candidate;
			continue;
		}
		if (line) lines.push(line);
		line = word;
		if (lines.length === maxLines - 1) {
			lines.push(truncate(words.slice(i).join(" "), width));
			return lines;
		}
	}
	if (line && lines.length < maxLines) lines.push(truncate(line, width));
	return lines;
}

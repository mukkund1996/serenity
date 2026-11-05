import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import {
	ago,
	ensureDaemon,
	groupByRepo,
	HISTORY_DAYS,
	type HistoryFilter,
	type HistoryResult,
	type HistorySession,
	historyLabel,
	LARGE_HISTORY_BYTES,
	parseDateArg,
	sizeLabel,
} from "@serenity/core";

/**
 * `serenity import` (ADR 0064): lists the Claude Code sessions you already
 * have that no map shows yet, by repo, and puts the chosen ones on their
 * maps. It needs no tmux; nothing runs until Enter on a card resumes one.
 */

export const IMPORT_USAGE = `usage: serenity import [options] [id…]

Lists past Claude Code sessions of this repo (and its worktrees) that no map
shows yet, and asks which to import. They go onto the map ended; Enter on one
resumes it with claude --resume in its own folder.

  --days N       look back N days (default ${HISTORY_DAYS})
  --since DATE   open on or after DATE (YYYY-MM-DD or ISO time)
  --until DATE   started on or before DATE (the whole day)
  --dir PATH     only sessions that ran in PATH or below it
  --all-repos    every repo, not just this one
  --list         only list them
  --yes          import all listed without asking
  id…            import these (the first 8 characters are enough)`;

export interface ImportArgs {
	filter: HistoryFilter;
	allRepos: boolean;
	list: boolean;
	yes: boolean;
	ids: string[];
	help: boolean;
}

/** Parses `serenity import`'s arguments; a string is the error to show. */
export function parseImportArgs(
	argv: string[],
	now = Date.now(),
): ImportArgs | string {
	const out: ImportArgs = {
		filter: {},
		allRepos: false,
		list: false,
		yes: false,
		ids: [],
		help: false,
	};
	let days: number | null = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		const value = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${arg} needs a value`);
			return v;
		};
		try {
			switch (arg) {
				case "--days": {
					const n = Number(value());
					if (!Number.isFinite(n) || n <= 0)
						return "--days takes a positive number";
					days = n;
					break;
				}
				case "--since":
				case "--until": {
					const v = value();
					const at = parseDateArg(v, arg === "--until");
					if (at === null) return `${arg}: not a date: ${v}`;
					out.filter[arg === "--since" ? "since" : "until"] = at;
					break;
				}
				case "--dir":
					out.filter.dir = value();
					break;
				case "--all-repos":
					out.allRepos = true;
					break;
				case "--list":
					out.list = true;
					break;
				case "--yes":
				case "-y":
					out.yes = true;
					break;
				case "--help":
				case "-h":
					out.help = true;
					break;
				default:
					if (arg.startsWith("-")) return `unknown option ${arg}`;
					out.ids.push(arg);
			}
		} catch (e) {
			return (e as Error).message;
		}
	}
	// The default window, unless dates or ids say what to look for.
	const explicit =
		out.filter.until !== undefined || (out.ids.length > 0 && days === null);
	if (out.filter.since === undefined && (days !== null || !explicit))
		out.filter.since = now - (days ?? HISTORY_DAYS) * 86_400_000;
	return out;
}

/** The numbered list, grouped by repo; numbers follow `order`. */
export function formatHistory(
	result: HistoryResult,
	order: HistorySession[],
	now: number,
): string {
	const lines: string[] = [];
	const number = new Map(order.map((s, i) => [s.claudeSessionId, i + 1]));
	const width = String(order.length).length;
	for (const group of groupByRepo(order)) {
		lines.push("", `${basename(group.repo)}  (${group.repo})`);
		for (const s of group.sessions) {
			const n = String(number.get(s.claudeSessionId)).padStart(width);
			const facts = [
				s.branch,
				ago(s.lastActiveAt, now),
				s.bytes >= LARGE_HISTORY_BYTES ? sizeLabel(s.bytes) : null,
				s.claudeSessionId.slice(0, 8),
			].filter(Boolean);
			lines.push(`  ${n}. ${s.name}  ·  ${facts.join(" · ")}`);
			lines.push(`  ${" ".repeat(width)}  ${historyLabel(s)}`);
			if (s.runningPid)
				lines.push(
					`  ${" ".repeat(width)}  still open in a terminal (pid ${s.runningPid}): quit it there before resuming`,
				);
		}
	}
	if (result.gone)
		lines.push(
			"",
			`${result.gone} more left out: their folder is gone, so they cannot resume.`,
		);
	return lines.join("\n");
}

/**
 * Which numbers an answer picks: "" is all, "n" none, else numbers and
 * ranges ("1 3 5-7", commas too). Null when it cannot be read.
 */
export function pickNumbers(answer: string, count: number): number[] | null {
	const a = answer.trim().toLowerCase();
	if (a === "" || a === "a" || a === "all" || a === "y")
		return Array.from({ length: count }, (_, i) => i + 1);
	if (a === "n" || a === "q" || a === "none") return [];
	const picked = new Set<number>();
	for (const part of a.split(/[\s,]+/)) {
		const m = part.match(/^(\d+)(?:-(\d+))?$/);
		if (!m) return null;
		const from = Number(m[1]);
		const to = Number(m[2] ?? m[1]);
		if (from < 1 || to > count || from > to) return null;
		for (let n = from; n <= to; n++) picked.add(n);
	}
	return [...picked].sort((x, y) => x - y);
}

/** The top of the git repo the shell is in, or null outside one. */
function hereRepo(): string | null {
	const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		encoding: "utf8",
	});
	return result.status === 0 ? result.stdout.trim() : null;
}

export async function runImport(home: string, argv: string[]): Promise<number> {
	const args = parseImportArgs(argv);
	if (typeof args === "string") {
		console.error(`serenity import: ${args}\n\n${IMPORT_USAGE}`);
		return 2;
	}
	if (args.help) {
		console.log(IMPORT_USAGE);
		return 0;
	}
	const repo = args.allRepos ? null : hereRepo();
	if (!args.allRepos && !repo) {
		console.error(
			"serenity import: run it inside a git repository, or pass --all-repos",
		);
		return 1;
	}
	const peer = await ensureDaemon(home);
	try {
		const result = await peer.request("history.discover", {
			...args.filter,
			...(repo ? { repo } : {}),
		});
		const now = Date.now();
		// Numbered in the order they are printed: by repo, newest first.
		const order = groupByRepo(result.sessions).flatMap((g) => g.sessions);
		const where = repo ? `in ${basename(repo)}` : "in any repo";
		if (!order.length) {
			console.log(
				`No Claude Code sessions ${where} to import: none match, or every one is on a map already.${result.gone ? ` (${result.gone} left out: folder gone.)` : ""}`,
			);
			return 0;
		}
		let chosen: HistorySession[];
		if (args.ids.length) {
			chosen = order.filter((s) =>
				args.ids.some((id) => s.claudeSessionId.startsWith(id)),
			);
			const unknown = args.ids.filter(
				(id) => !order.some((s) => s.claudeSessionId.startsWith(id)),
			);
			if (unknown.length)
				console.error(`not found (or already on a map): ${unknown.join(", ")}`);
		} else {
			console.log(
				`Claude Code sessions ${where} that no serenity map shows yet:`,
			);
			console.log(formatHistory(result, order, now));
			console.log("");
			if (args.list) return 0;
			if (args.yes) chosen = order;
			else if (!process.stdin.isTTY) {
				console.log(
					"Pass --yes to import them all, or their ids to import some.",
				);
				return 0;
			} else {
				const rl = createInterface({
					input: process.stdin,
					output: process.stdout,
				});
				let picked: number[] | null = null;
				try {
					while (picked === null) {
						const answer = await rl.question(
							`Import which? Enter for all ${order.length}, numbers like 1 3 5-7, n for none: `,
						);
						picked = pickNumbers(answer, order.length);
						if (picked === null) console.log("Didn't get that.");
					}
				} finally {
					rl.close();
				}
				chosen = picked.map((n) => order[n - 1] as HistorySession);
			}
		}
		if (!chosen.length) {
			console.log("Nothing imported.");
			return 0;
		}
		const imported = await peer.request("history.import", {
			claudeSessionIds: chosen.map((s) => s.claudeSessionId),
		});
		const repos = [...new Set(imported.map((s) => s.repo))];
		console.log(
			`Imported ${imported.length} ${imported.length === 1 ? "session" : "sessions"}: ${imported.map((s) => s.name).join(", ")}.`,
		);
		console.log(
			`Run serenity in ${repos.length === 1 ? repos[0] : "each repo"} and press Enter on one to resume it there.`,
		);
		if (chosen.some((s) => s.runningPid))
			console.log(
				"Quit the ones still open in a terminal (/exit) before you resume them.",
			);
		return 0;
	} finally {
		peer.close();
	}
}

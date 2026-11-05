import { oneLine } from "./status";

/**
 * Importing past Claude Code sessions from their transcripts (ADR 0064).
 * Claude keeps every conversation at
 * `<config>/projects/<cwd slug>/<session id>.jsonl`. The slug cannot be
 * turned back into a path (`/` and `-` both become `-`), so where a session
 * ran comes from the transcript's own `cwd` field. Like observed.ts, this
 * reads an undocumented format and tolerates missing or unknown fields.
 */

/** What the first lines of a transcript say about the session. */
export interface TranscriptHead {
	sessionId: string | null;
	cwd: string | null;
	branch: string | null;
	/** How claude was started: "cli", "sdk-cli" (headless `-p`), … */
	entrypoint: string | null;
	/** The first entry's time (epoch ms). */
	startedAt: number | null;
	/** The user's first real prompt, on one line. */
	firstPrompt: string | null;
	/** A subagent's transcript, not a conversation of its own. */
	sidechain: boolean;
}

/** Reads the start of a transcript; a partial last line is skipped. */
export function readTranscriptHead(text: string): TranscriptHead {
	const head: TranscriptHead = {
		sessionId: null,
		cwd: null,
		branch: null,
		entrypoint: null,
		startedAt: null,
		firstPrompt: null,
		sidechain: false,
	};
	let first = true;
	for (const line of text.split("\n")) {
		if (!line.startsWith("{")) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (first && entry.isSidechain === true) head.sidechain = true;
		first = false;
		head.sessionId ??= str(entry.sessionId);
		head.cwd ??= str(entry.cwd);
		head.entrypoint ??= str(entry.entrypoint);
		head.branch ??= str(entry.gitBranch);
		if (head.startedAt === null && typeof entry.timestamp === "string") {
			const at = Date.parse(entry.timestamp);
			if (Number.isFinite(at)) head.startedAt = at;
		}
		if (
			!head.firstPrompt &&
			entry.type === "user" &&
			entry.isMeta !== true &&
			entry.isSidechain !== true
		)
			head.firstPrompt = promptText(entry.message);
	}
	return head;
}

const str = (v: unknown): string | null =>
	typeof v === "string" && v ? v : null;

/**
 * A user entry's typed text. Slash-command wrappers (`<command-name>`),
 * command output, reminders and tool results are not prompts.
 */
function promptText(message: unknown): string | null {
	const content = (message as { content?: unknown } | undefined)?.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter(
							(b): b is { type: "text"; text: string } =>
								b?.type === "text" && typeof b.text === "string",
						)
						.map((b) => b.text)
						.join("\n")
				: "";
	const trimmed = text.trim();
	if (!trimmed || trimmed.startsWith("<") || trimmed.startsWith("Caveat:"))
		return null;
	return oneLine(trimmed);
}

/**
 * Whether a transcript is a conversation the user had and could resume:
 * not a subagent's, not a headless `claude -p` run (serenity's own workers
 * among them), and with a prompt or title to show.
 */
export function isImportable(
	head: TranscriptHead,
	title: string | null,
): boolean {
	if (head.sidechain || !head.sessionId || !head.cwd) return false;
	if (head.entrypoint?.startsWith("sdk")) return false;
	return !!(head.firstPrompt || title);
}

/** A past session that could be imported onto a repo's map. */
export interface HistorySession {
	claudeSessionId: string;
	/** Where it ran, as Claude recorded it; `claude --resume` must run there. */
	cwd: string;
	/** The main checkout of its repo: the map it goes onto. */
	repo: string;
	/** The branch it was last on, from the transcript; null when detached. */
	branch: string | null;
	/** The user's title for it, else Claude's. */
	title: string | null;
	firstPrompt: string | null;
	lastPrompt: string | null;
	startedAt: number;
	/** The transcript's last write (epoch ms). */
	lastActiveAt: number;
	/** The transcript's size; a big one resumes slowly. */
	bytes: number;
	/**
	 * A claude outside tmux still running this conversation. It can be
	 * imported, but resumes only once it has exited (ADR 0064).
	 */
	runningPid: number | null;
	/** The name it would get on the map. */
	name: string;
}

/** Which past sessions to list. Times are epoch ms. */
export interface HistoryFilter {
	/** Only this repo's; any path inside it or one of its worktrees. */
	repo?: string;
	/** Active at or after this time. */
	since?: number;
	/** Started at or before this time. */
	until?: number;
	/** Only those that ran in this directory or below it. */
	dir?: string;
}

export interface HistoryResult {
	sessions: HistorySession[];
	/** Left out because their folder no longer exists, so they cannot resume. */
	gone: number;
}

/** Whether the session was open at some point in [since, until]. */
export function inWindow(
	s: Pick<HistorySession, "startedAt" | "lastActiveAt">,
	since?: number,
	until?: number,
): boolean {
	if (since !== undefined && s.lastActiveAt < since) return false;
	if (until !== undefined && s.startedAt > until) return false;
	return true;
}

/** Whether `path` is `dir` or inside it. */
export function underDir(path: string, dir: string): boolean {
	const d = dir.replace(/\/+$/, "") || "/";
	return path === d || path.startsWith(d === "/" ? "/" : `${d}/`);
}

/** What to show for a past session: its title, else how it began. */
export function historyLabel(
	s: Pick<HistorySession, "title" | "firstPrompt" | "lastPrompt">,
): string {
	return s.title ?? s.firstPrompt ?? s.lastPrompt ?? "no prompt";
}

/** Sessions by repo, the repo with the latest activity first, newest first within. */
export function groupByRepo(
	sessions: HistorySession[],
): Array<{ repo: string; sessions: HistorySession[] }> {
	const groups = new Map<string, HistorySession[]>();
	for (const s of [...sessions].sort(
		(a, b) => b.lastActiveAt - a.lastActiveAt,
	)) {
		const list = groups.get(s.repo) ?? [];
		list.push(s);
		groups.set(s.repo, list);
	}
	return [...groups].map(([repo, list]) => ({ repo, sessions: list }));
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date the master or the CLI was given: "2026-11-03" is that local day's
 * start, or its end with `endOfDay`; anything else Date.parse reads.
 */
export function parseDateArg(value: unknown, endOfDay = false): number | null {
	if (typeof value !== "string" || !value.trim()) return null;
	const v = value.trim();
	if (DATE_ONLY.test(v)) {
		const [y, m, d] = v.split("-").map(Number) as [number, number, number];
		const at = endOfDay
			? new Date(y, m - 1, d, 23, 59, 59, 999)
			: new Date(y, m - 1, d);
		return Number.isNaN(at.getTime()) ? null : at.getTime();
	}
	const at = Date.parse(v);
	return Number.isFinite(at) ? at : null;
}

/** "just now", "3m ago", "5h ago", "2d ago". */
export function ago(at: number, now: number): string {
	const minutes = Math.max(0, Math.round((now - at) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/** "840 KB", "12 MB". */
export function sizeLabel(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Above this, the picker shows the size: resuming such a history is slow. */
export const LARGE_HISTORY_BYTES = 10 * 1024 * 1024;

/** How far back `I` and `serenity import` look by default. */
export const HISTORY_DAYS = 14;

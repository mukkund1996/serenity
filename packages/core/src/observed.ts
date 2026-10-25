import type { Session } from "./domain";
import { oneLine, REPLY_MAX } from "./status";

/**
 * Adopted sessions (ADR 0016): a claude the user started in their own tmux
 * window has no serenity hooks, so its state is read from what Claude Code
 * writes anyway: `<config>/sessions/<pid>.json` (status, tmux pane) and the
 * transcript (title, last prompt, last reply). Neither is a documented
 * format; everything here tolerates missing or unknown fields.
 */

/** One running interactive claude, from its session file. */
export interface ClaudeProcess {
	pid: number;
	sessionId: string;
	cwd: string;
	/** tmux pane id, e.g. "%258". */
	pane: string;
	/** Claude's own name for the session, e.g. "perry-poc-7a". */
	name: string | null;
	/** idle · busy · waiting · needs_trust · … */
	status: string;
	/** Why it waits, e.g. "input needed". */
	waitingFor: string | null;
}

const TMUX_FIELD = /:@\d+\.(%\d+)$/;

/** Parses a session file; null for anything that is not an interactive claude in tmux. */
export function parseClaudeProcess(raw: unknown): ClaudeProcess | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const pane =
		typeof o.tmux === "string" ? o.tmux.match(TMUX_FIELD)?.[1] : undefined;
	if (
		o.kind !== "interactive" ||
		typeof o.pid !== "number" ||
		typeof o.sessionId !== "string" ||
		typeof o.cwd !== "string" ||
		!pane
	)
		return null;
	return {
		pid: o.pid,
		sessionId: o.sessionId,
		cwd: o.cwd,
		pane,
		name: typeof o.name === "string" ? o.name : null,
		status: typeof o.status === "string" ? o.status : "idle",
		waitingFor: typeof o.waitingFor === "string" ? o.waitingFor : null,
	};
}

/** Where Claude Code keeps a session's transcript. */
export function transcriptPathFor(
	configDir: string,
	cwd: string,
	sessionId: string,
): string {
	return `${configDir}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}/${sessionId}.jsonl`;
}

export interface TranscriptTail {
	/** The user's title for the conversation, else Claude's. */
	title: string | null;
	lastPrompt: string | null;
	/** Text of the last main-thread assistant message. */
	lastReply: string | null;
	branch: string | null;
}

/** Reads the end of a transcript (JSON lines; a partial first line is skipped). */
export function readTranscriptTail(text: string): TranscriptTail {
	let customTitle: string | null = null;
	let aiTitle: string | null = null;
	const tail: TranscriptTail = {
		title: null,
		lastPrompt: null,
		lastReply: null,
		branch: null,
	};
	for (const line of text.split("\n")) {
		if (!line.startsWith("{")) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof entry.gitBranch === "string" && entry.gitBranch)
			tail.branch = entry.gitBranch;
		if (entry.type === "custom-title" && typeof entry.customTitle === "string")
			customTitle = entry.customTitle;
		else if (entry.type === "ai-title" && typeof entry.aiTitle === "string")
			aiTitle = entry.aiTitle;
		else if (
			entry.type === "last-prompt" &&
			typeof entry.lastPrompt === "string"
		)
			tail.lastPrompt = oneLine(entry.lastPrompt);
		else if (entry.type === "assistant" && !entry.isSidechain) {
			const text = assistantText(entry.message);
			if (text) tail.lastReply = oneLine(text, REPLY_MAX);
		}
	}
	tail.title = customTitle ?? aiTitle;
	return tail;
}

function assistantText(message: unknown): string | null {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return null;
	const text = content
		.filter(
			(b): b is { type: "text"; text: string } =>
				b?.type === "text" && typeof b.text === "string",
		)
		.map((b) => b.text)
		.join("\n");
	return text.trim() ? text : null;
}

/**
 * The permission prompt on an agent's screen, as a one-line ask; null when
 * the screen shows none. Claude's prompt ends in a numbered menu whose first
 * option is "Yes", which is what the approve suggestion presses.
 */
export function permissionPrompt(screen: string): string | null {
	// Without box borders, if the dialog draws any.
	const lines = screen
		.split("\n")
		.slice(-30)
		.map((l) => l.replace(/[│┃║]/g, " ").trim());
	if (!lines.some((l) => /^(❯\s*)?1\.\s*Yes\b/.test(l))) return null;
	const header = lines.findIndex((l) => l === "Bash command");
	const command =
		header === -1 ? undefined : lines.slice(header + 1).find((l) => l);
	if (command) return oneLine(`wants to run ${command}`);
	return (
		oneLine(lines.find((l) => /Do you want to/.test(l))) ?? "needs permission"
	);
}

export interface Observation {
	process: ClaudeProcess;
	tail: TranscriptTail;
	/** From permissionPrompt() when the process waits, else null. */
	permission: string | null;
}

export const STARTUP_ASK = "confirm Claude's startup prompt (folder trust)";

/**
 * Applies what Claude reports to an observed session, like reduceHook does
 * for hooks. Returns only the fields that change. Archived is sticky, and a
 * session the master marked finished stays so until a new turn shows up.
 */
export function reduceObserved(
	session: Session,
	{ process, tail, permission }: Observation,
): Partial<Session> {
	const next: Partial<Session> = { claudePid: process.pid };
	if (session.status !== "archived") {
		switch (process.status) {
			case "busy":
				Object.assign(next, {
					status: "working",
					ask: null,
					waitingOn: null,
					lastPrompt: tail.lastPrompt ?? session.lastPrompt,
					lastAssistantMessage: null,
				});
				break;
			case "waiting":
				Object.assign(next, {
					status: "waiting",
					waitingOn: permission ? "permission" : "question",
					ask: permission ?? oneLine(process.waitingFor) ?? "needs you",
					lastPrompt: tail.lastPrompt ?? session.lastPrompt,
				});
				break;
			case "needs_trust":
				Object.assign(next, {
					status: "waiting",
					waitingOn: "startup",
					ask: STARTUP_ASK,
				});
				break;
			default: {
				const finished =
					session.status === "done" &&
					tail.lastReply === session.lastAssistantMessage;
				if (!finished)
					Object.assign(next, {
						status: "idle",
						ask: null,
						waitingOn: null,
						lastPrompt: tail.lastPrompt ?? session.lastPrompt,
						lastAssistantMessage: tail.lastReply,
					});
			}
		}
	}
	return Object.fromEntries(
		Object.entries(next).filter(
			([key, value]) => session[key as keyof Session] !== value,
		),
	) as Partial<Session>;
}

const AUTOMATIC_NAME = /^(\d+(\.\d+)+|zsh|bash|fish|sh|claude|node|)$/;

/** Map name for an adopted session: its tmux window, else its title, else Claude's name. */
export function adoptedName(
	options: Array<string | null | undefined>,
	taken: ReadonlySet<string>,
): string {
	const slugs = options
		.map((o) =>
			(o ?? "")
				.toLowerCase()
				.replace(/[^a-z0-9._-]+/g, "-")
				.replace(/^[-._]+|-+$/g, "")
				.slice(0, 36)
				.replace(/-+$/, ""),
		)
		.filter((s) => !AUTOMATIC_NAME.test(s));
	const base = slugs[0] ?? "session";
	let name = base;
	for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
	return name;
}

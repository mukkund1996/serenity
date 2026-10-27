import type { GithubState, PrInfo } from "./pr";
import type { SlackState } from "./slack";

export const VERSION = "0.4.0";

/** Set by scripts/build.ts: the commit and time of a compiled build. */
declare const SERENITY_BUILD: string | undefined;

/**
 * This exact build, e.g. "0.4.0+3f2a9c1.1029-1650", or "0.4.0+dev" when run
 * from source. Clients and daemon must match, so installing a new build
 * replaces the running daemon on the next connect (docs/dogfooding.md).
 */
export const BUILD_ID = `${VERSION}+${typeof SERENITY_BUILD === "string" ? SERENITY_BUILD : "dev"}`;

export type SessionStatus =
	| "waiting"
	| "working"
	| "idle"
	| "done"
	| "dead"
	| "archived";

export interface Session {
	id: string;
	/** Absolute path of the repo root this session belongs to; the map is scoped by it. */
	repo: string;
	name: string;
	/** Assigned by the master; null until it has placed the session. */
	topic: string | null;
	cwd: string;
	worktree: string | null;
	branch: string | null;
	/** serenity created the branch, so cleanup may delete it once merged. */
	ownsBranch: boolean;
	/** The branch's pull request, from gh (ADR 0011); null when there is none. */
	pr: PrInfo | null;
	/** Why PR status could not be read (gh missing, not logged in), or null. */
	prError: string | null;
	tmuxPane: string | null;
	/**
	 * "spawned": serenity started it in its own tmux window. "adopted": a
	 * claude the user already ran in their own tmux window (ADR 0016); its
	 * pane stays there and attaching switches to it.
	 */
	origin: SessionOrigin;
	/**
	 * Where status comes from: serenity's hooks, or, for an adopted session
	 * not yet restarted, Claude's own session file and transcript.
	 */
	tracking: SessionTracking;
	/** The claude process of an observed session; null otherwise. */
	claudePid: number | null;
	status: SessionStatus;
	/** ≤2 sentences, written by the master. */
	summary: string | null;
	/** One line: what the agent needs from the user. */
	ask: string | null;
	/** Why a waiting session waits; decides which suggestions apply. */
	waitingOn: WaitingOn | null;
	/** When the current wait on you began; null unless waiting. */
	waitingSince: number | null;
	/** A different topic the summarizer proposed once; adopted if proposed again. */
	topicCandidate: string | null;
	lastPrompt: string | null;
	lastAssistantMessage: string | null;
	/**
	 * Subagents started and not yet stopped. A turn that ends while any run
	 * (background agents) is still working on their results.
	 */
	subagents: string[];
	transcriptPath: string | null;
	claudeSessionId: string | null;
	watched: boolean;
	/**
	 * Kept for reuse (ADR 0022): shown under the pinned topic, never marked
	 * done or offered a cleanup, and resumed on attach once it has ended.
	 */
	pinned: boolean;
	createdAt: number;
	updatedAt: number;
}

export type WaitingOn = "permission" | "question" | "startup";

export type SessionOrigin = "spawned" | "adopted";

export type SessionTracking = "hooks" | "observed";

/** A claude found running in tmux that the map does not track yet (ADR 0016). */
export interface ImportCandidate {
	claudeSessionId: string;
	pid: number;
	tmuxPane: string;
	/** Where it runs, e.g. "guide:0 modals". */
	location: string;
	/** The name it would get on the map. */
	name: string;
	/** Claude's own title for the conversation, if any. */
	title: string | null;
	lastPrompt: string | null;
	cwd: string;
	branch: string | null;
	status: SessionStatus;
}

export const HOOK_KINDS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PermissionRequest",
	"Notification",
	"Stop",
	"SubagentStart",
	"SubagentStop",
	"SessionEnd",
] as const;

export type HookKind = (typeof HOOK_KINDS)[number];

export function isHookKind(value: string): value is HookKind {
	return (HOOK_KINDS as readonly string[]).includes(value);
}

/** The JSON Claude Code writes to a hook's stdin. Only the fields we read are typed. */
export interface HookPayload {
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
	hook_event_name?: string;
	prompt?: string;
	message?: string;
	notification_type?: string;
	last_assistant_message?: string;
	tool_name?: string;
	/** Set on events from inside a subagent, and on SubagentStart/Stop. */
	agent_id?: string;
	[key: string]: unknown;
}

export interface HookEvent {
	id: number;
	sessionId: string;
	kind: HookKind;
	payload: HookPayload;
	at: number;
}

export type SuggestionKind = "reply" | "approve" | "cleanup" | "review";

export type SuggestionStatus =
	| "pending"
	| "accepted"
	| "declined"
	| "superseded"
	| "failed";

/** A proposed action for one session; nothing runs until the user presses y (ADR 0008). */
export interface Suggestion {
	id: string;
	repo: string;
	sessionId: string;
	kind: SuggestionKind;
	/** The ◆ line, e.g. 'Reply "yes, set it to 15m"'. */
	label: string;
	/** The text to send for replies; the reviewer's login for reviews. */
	text: string | null;
	status: SuggestionStatus;
	source: "worker" | "chat";
	createdAt: number;
	updatedAt: number;
}

export interface MasterMessage {
	id: number;
	repo: string;
	from: "you" | "master";
	text: string;
	at: number;
}

/** The master asking to use a tool outside its read-only set; shown at the top of NEEDS YOU. */
export interface MasterPermission {
	id: string;
	repo: string;
	toolName: string;
	/** One line describing the call, e.g. the command. */
	detail: string;
	at: number;
}

export interface MasterState {
	/** "thinking" while the chat or a worker is running. */
	status: "idle" | "thinking";
	/** Last failure (chat or worker), shown until the next success. */
	error: string | null;
}

/** One stretch a session spent waiting on you, answered (ADR 0020). */
export interface Wait {
	repo: string;
	sessionId: string;
	startedAt: number;
	endedAt: number;
}

/** One of Claude's plan limits, as its status line reports it. */
export interface UsageWindow {
	/** 0–100. */
	usedPercent: number;
	/** Epoch ms; null when Claude did not say. */
	resetsAt: number | null;
}

/** The account's plan usage, from the latest status line of any session (ADR 0020). */
export interface Usage {
	/** The 5-hour session limit. */
	session: UsageWindow | null;
	/** The 7-day limit. */
	week: UsageWindow | null;
	/** When it was reported. */
	at: number;
}

/** What a client sees for one repo. */
export interface RepoState {
	repo: string;
	sessions: Session[];
	/** Session currently joined into a serenity window, if any. */
	attachedSessionId: string | null;
	/** Pending suggestions only. */
	suggestions: Suggestion[];
	/** The latest exchange with the master, oldest first. */
	conversation: MasterMessage[];
	permissions: MasterPermission[];
	master: MasterState;
	/** Review requests and the gh user, for the master panel. */
	github: GithubState;
	/** Plan usage; null until a session's status line has reported it. */
	usage: Usage | null;
	/** Average wait on you over the last day; null when nothing waited. */
	averageWaitMs: number | null;
	/** Slack threads and mentions waiting on you; null when Slack is off for the repo (ADR 0023). */
	slack: SlackState | null;
}

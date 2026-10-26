import { PINNED, topicOf } from "./attention";
import type { Session, Suggestion, SuggestionKind } from "./domain";
import { prStatus } from "./pr";

/**
 * The master's model-facing logic (ADR 0007), kept pure: prompts, JSON
 * schemas, parsing of what the models return, and the rules for applying it.
 */

/** Fits the 4 text rows of a 36-column card. */
const SUMMARY_MAX = 130;
const ASK_MAX = 100;
const LABEL_MAX = 60;
const TOPIC_MAX = 20;

/** "PR #482 checks passing", or what is known instead. */
export function prLine(session: Session): string {
	if (session.pr)
		return `PR #${session.pr.number} ${prStatus(session.pr).text}`;
	return session.prError ? `PR unknown (${session.prError})` : "no PR yet";
}

function clip(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Lowercase, single-spaced, short; empty becomes null. */
export function normalizeTopic(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const name = raw
		.toLowerCase()
		.replace(/[^a-z0-9 _-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, TOPIC_MAX)
		.trim();
	return name || null;
}

/**
 * Sticky topics: a session without one takes the proposal; a different
 * proposal only wins when it comes twice in a row, so bubbles do not jump.
 */
export function nextTopic(
	session: Pick<Session, "topic" | "topicCandidate">,
	proposed: string | null,
): Pick<Session, "topic" | "topicCandidate"> {
	if (!proposed || proposed === session.topic)
		return { topic: session.topic, topicCandidate: null };
	if (!session.topic || session.topicCandidate === proposed)
		return { topic: proposed, topicCandidate: null };
	return { topic: session.topic, topicCandidate: proposed };
}

/**
 * A topic proposal under the cap: an existing topic, or a new one while
 * there are fewer than `maxTopics`. Anything else is dropped (null), as is
 * the pinned topic, which only the user's pin puts a session in.
 */
export function capTopic(
	proposed: string | null,
	topics: string[],
	maxTopics: number,
): string | null {
	if (proposed === PINNED) return null;
	if (!proposed || topics.includes(proposed)) return proposed;
	return topics.length < maxTopics ? proposed : null;
}

// ---------------------------------------------------------------- summarizer

/**
 * The summarizer's JSON schema. Once a repo has `maxTopics` topics the
 * topic must be one of them, so the model cannot open another.
 */
export function summarySchema(topics: string[], maxTopics: number) {
	return {
		type: "object",
		properties: {
			summary: { type: "string" },
			ask: { type: ["string", "null"] },
			finished: { type: "boolean" },
			topic:
				topics.length >= maxTopics
					? { type: "string", enum: topics }
					: { type: "string" },
		},
		required: ["summary", "ask", "finished", "topic"],
		additionalProperties: false,
	} as const;
}

export interface SummaryResult {
	summary: string;
	ask: string | null;
	finished: boolean;
	topic: string | null;
}

export function summaryPrompt(
	session: Session,
	topics: string[],
	maxTopics: number,
): string {
	const full = topics.length >= maxTopics;
	return [
		"You keep a dashboard of coding-agent sessions and describe one session for its card.",
		"",
		`Session: ${session.name}${session.branch ? ` (branch ${session.branch})` : ""}`,
		`The user's last prompt: ${session.lastPrompt ?? "(none)"}`,
		`The agent's last reply: ${session.lastAssistantMessage ?? "(none)"}`,
		`Existing topics: ${topics.length ? topics.join(", ") : "(none yet)"}`,
		"",
		"Return:",
		`- summary: what this session is doing or did, compact: 1–2 short sentences, at most ${SUMMARY_MAX} characters. Describe the work, not yourself; no filler.`,
		`- ask: if the reply asks the user a question or for a decision, that question in one line under ${ASK_MAX} characters; otherwise null.`,
		"- finished: true only if the reply says the task is complete and nothing is asked.",
		full
			? `- topic: one of the existing topics, the closest fit. There are already ${maxTopics}, the most allowed.`
			: `- topic: a short lowercase name of 1–2 words for grouping sessions. Strongly prefer an existing topic, even a loose fit: a broad topic with many sessions beats a new one. Create a new topic only when no existing one is related at all. At most ${maxTopics} topics in total.`,
	].join("\n");
}

export function parseSummary(raw: unknown): SummaryResult | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.summary !== "string" || typeof r.finished !== "boolean")
		return null;
	const ask = typeof r.ask === "string" && r.ask.trim() ? r.ask : null;
	return {
		summary: clip(r.summary, SUMMARY_MAX),
		ask: ask ? clip(ask, ASK_MAX) : null,
		finished: r.finished && !ask,
		topic: normalizeTopic(r.topic),
	};
}

/**
 * What a summary changes on the session. An ask makes it wait on a question;
 * a finished task is done. Only applied to a session that is still idle, so
 * a summary arriving late never overrides newer activity. A pinned session
 * keeps its topic for when it is unpinned, and is never done (ADR 0022).
 */
export function applySummary(
	session: Session,
	result: SummaryResult,
): Partial<Session> {
	const patch: Partial<Session> = {
		summary: result.summary,
		...(session.pinned ? {} : nextTopic(session, result.topic)),
	};
	if (session.status !== "idle") return patch;
	if (result.ask) {
		patch.status = "waiting";
		patch.waitingOn = "question";
		patch.ask = result.ask;
	} else if (result.finished && !session.pinned) {
		patch.status = "done";
	}
	return patch;
}

// ----------------------------------------------------------------- suggester

export const SUGGESTION_SCHEMA = {
	type: "object",
	properties: {
		kind: { type: "string", enum: ["reply", "approve", "cleanup", "none"] },
		label: { type: "string" },
		text: { type: ["string", "null"] },
	},
	required: ["kind", "label", "text"],
	additionalProperties: false,
} as const;

export interface SuggestionResult {
	kind: SuggestionKind;
	label: string;
	text: string | null;
}

/**
 * A session needs a suggestion when it starts to need the user, or when its
 * PR merges after it was already done (a cleanup becomes possible then).
 */
export function needsSuggestion(before: Session, after: Session): boolean {
	const needs = (s: Session) => s.status === "waiting" || s.status === "done";
	const justMerged =
		after.pr?.state === "MERGED" && before.pr?.state !== "MERGED";
	return (
		needs(after) &&
		(!needs(before) ||
			before.status !== after.status ||
			before.ask !== after.ask ||
			justMerged)
	);
}

export function suggestionPrompt(session: Session): string {
	const kinds = [
		session.waitingOn === "permission"
			? "- approve: the agent is blocked on a tool permission prompt and approving it looks safe."
			: null,
		session.waitingOn === "question" || session.waitingOn === null
			? "- reply: the agent asked a question; text is the short reply the user would most likely send."
			: null,
		session.status === "done" && !session.pinned
			? `- cleanup: the task is finished; stop the session${session.worktree ? " and remove its worktree" : ""}.`
			: null,
		"- none: nothing sensible to suggest.",
	].filter(Boolean);
	return [
		"Suggest the single most useful next action for a coding-agent session that needs its user.",
		"",
		`Session: ${session.name}`,
		`Status: ${session.status}${session.waitingOn ? ` (waiting on ${session.waitingOn})` : ""}`,
		`It asks: ${session.ask ?? "(nothing)"}`,
		`Summary: ${session.summary ?? "(none)"}`,
		`Pull request: ${prLine(session)}`,
		`The user's last prompt: ${session.lastPrompt ?? "(none)"}`,
		`The agent's last reply: ${session.lastAssistantMessage ?? "(none)"}`,
		"",
		"Allowed kinds:",
		...kinds,
		"",
		`label: what will happen, imperative, under ${LABEL_MAX} characters, e.g. Reply "yes, set it to 15m", Approve: terraform plan, Clean up the worktree.`,
		"text: the reply text for reply; otherwise null.",
	].join("\n");
}

/** Validates the suggester's answer against what the session allows. */
export function parseSuggestion(
	raw: unknown,
	session: Session,
): SuggestionResult | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const label = typeof r.label === "string" ? clip(r.label, LABEL_MAX) : "";
	const text =
		typeof r.text === "string" && r.text.trim() ? r.text.trim() : null;
	if (!label) return null;
	if (r.kind === "approve" && session.waitingOn === "permission")
		return { kind: "approve", label, text: null };
	if (r.kind === "reply" && text && session.waitingOn !== "permission")
		return { kind: "reply", label, text };
	if (
		r.kind === "cleanup" &&
		session.status === "done" &&
		!session.pinned &&
		session.pr?.state !== "OPEN"
	)
		return { kind: "cleanup", label, text: null };
	return null;
}

// --------------------------------------------------------------------- chat

export const MASTER_SYSTEM_PROMPT = [
	"You are the master in serenity, a terminal map of the user's Claude Code sessions in one repo.",
	"Each message from the user starts with a snapshot of every session; trust it over memory.",
	"You can read the repo (Read, Grep, Glob, read-only git and gh). You cannot change files, and you change sessions only through the serenity tools below.",
	"To propose an action, call mcp__serenity__suggest with the session name, kind (reply, approve or cleanup), a short label and, for replies, the text. Nothing runs until the user presses y.",
	"Call mcp__serenity__set_topic only when the user asks to move a session.",
	"Call mcp__serenity__open_session when the user asks to open, show or go to a session; it opens beside their map.",
	"Call mcp__serenity__archive_session only when the user asks to kill, stop or archive a session; it stops the agent at once.",
	"Answer in at most 3 short sentences; your replies are shown in a small panel. No markdown headings or tables.",
].join("\n");

/** The snapshot prepended to each user message sent to the chat. */
export function chatSnapshot(
	sessions: Session[],
	suggestions: Suggestion[],
): string {
	if (!sessions.length) return "Sessions: none yet.";
	const lines = sessions.map((s) => {
		const parts = [
			`- ${s.name} [${topicOf(s)}] ${s.status}${s.waitingOn ? ` on ${s.waitingOn}` : ""}`,
		];
		if (s.ask) parts.push(`asks: ${s.ask}`);
		if (s.pr || s.prError) parts.push(prLine(s));
		if (s.summary) parts.push(`summary: ${s.summary}`);
		else if (s.lastPrompt)
			parts.push(`last prompt: ${clip(s.lastPrompt, 120)}`);
		const pending = suggestions.find((g) => g.sessionId === s.id);
		if (pending) parts.push(`pending suggestion: ${pending.label}`);
		return parts.join(" · ");
	});
	return ["Sessions now:", ...lines].join("\n");
}

export function chatMessage(snapshot: string, text: string): string {
	return `${snapshot}\n\nUser: ${text}`;
}

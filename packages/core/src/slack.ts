import type { MasterMessage, Session } from "./domain";
import { prLine } from "./master";
import type { ReviewRequest } from "./pr";

/**
 * Slack for the master (ADR 0023, 0031): the mentions and DMs that still need
 * the user to act, read through Slack's MCP server by a one-shot `claude -p`. Pure:
 * the prompt, the JSON schema, and parsing of what the model returns.
 */

/** The MCP server's name in serenity's `--mcp-config`; tools are `mcp__slack__<tool>`. */
export const SLACK_SERVER = "slack";

/**
 * Slack's own MCP server, with the OAuth client of Claude Code's Slack
 * plugin. `serenity slack login` signs in to it once.
 */
export const DEFAULT_SLACK_MCP: Record<string, unknown> = {
	type: "http",
	url: "https://mcp.slack.com/mcp",
	oauth: { clientId: "1601185624273.8899143856786", callbackPort: 3118 },
};

/** Slack tools that only read; the inbox worker may use these and nothing else. */
export const SLACK_READ_TOOLS = [
	"slack_search_public_and_private",
	"slack_search_public",
	"slack_search_channels",
	"slack_search_users",
	"slack_read_channel",
	"slack_read_thread",
	"slack_read_user_profile",
	"slack_get_reactions",
	"slack_list_user_channels",
].map((tool) => `mcp__${SLACK_SERVER}__${tool}`);

/** Items shown at most: they join NEEDS YOU, so only the few that matter. */
export const SLACK_LIMIT = 3;
const TEXT_MAX = 200;
const ACTION_MAX = 80;

export type SlackReason = "mention" | "dm";

/** One mention or DM that needs the user to act. */
export interface SlackItem {
	/** `<channel id>:<thread ts>`: one item per thread. */
	id: string;
	channelId: string;
	/** "#eng", or the DM's name. */
	channel: string;
	author: string;
	/** The message waiting on the user, one line. */
	text: string;
	reason: SlackReason;
	/** What the user has to do, e.g. "Answer whether the auth fix shipped". */
	action: string;
	/** The waiting message's ts. */
	ts: string;
	/** The thread's root ts; the message's own when it starts the thread. */
	threadTs: string;
	permalink: string | null;
	/** When the waiting message was posted, ms since the epoch. */
	at: number;
}

/**
 * The master's proposal for one Slack item (ADR 0024): a reply to post in
 * its thread, or a question for a session that likely knows the answer.
 * Nothing runs until the user presses y.
 */
export interface SlackSuggestion {
	itemId: string;
	kind: "reply" | "ask";
	/** The ◆ line, e.g. 'Reply "merged in #42"'. */
	label: string;
	/** The reply to post, or the question to type to the session. */
	text: string;
	/** The session asked (ask), or the one the reply draws on; null if none. */
	sessionId: string | null;
	/**
	 * "asked": the question was typed to the session and its answer is
	 * awaited. "sending": the reply is being posted.
	 */
	status: "pending" | "asked" | "sending";
}

/** What a map of a repo with Slack enabled shows. */
export interface SlackState {
	/** Newest first, at most SLACK_LIMIT. */
	items: SlackItem[];
	/** At most one per item, for this repo. */
	suggestions: SlackSuggestion[];
	/** Why Slack could not be read (no login, a failed call), or null. */
	error: string | null;
	/** When Slack was last read; null before the first read. */
	checkedAt: number | null;
}

/** Slack as read for the whole account, before a repo's suggestions are added. */
export type SlackInbox = Omit<SlackState, "suggestions">;

/**
 * A Slack message the user dismissed from NEEDS YOU (ADR 0034), kept for
 * good. Keyed by the message, not the thread: a newer message in the same
 * thread or DM is a new item.
 */
export interface SlackDismissal {
	channelId: string;
	/** The dismissed message's ts. */
	ts: string;
	/** When it was dismissed, ms since the epoch. */
	at: number;
}

/** One Slack message's identity: its channel and ts. */
export function slackMessageKey(m: { channelId: string; ts: string }): string {
	return `${m.channelId}@${m.ts}`;
}

/** How far back the inbox looks, and so how long a dismissal matters to it. */
const INBOX_WINDOW_MS = 7 * 24 * 3600_000;

export const SLACK_LOGIN_HINT = "Slack needs a login: run serenity slack login";

export const SLACK_INBOX_SCHEMA = {
	type: "object",
	properties: {
		access: { type: "string", enum: ["ok", "no_access"] },
		problem: { type: ["string", "null"] },
		items: {
			type: "array",
			items: {
				type: "object",
				properties: {
					channelId: { type: "string" },
					channel: { type: "string" },
					author: { type: "string" },
					text: { type: "string" },
					reason: { type: "string", enum: ["mention", "dm"] },
					action: { type: "string" },
					ts: { type: "string" },
					threadTs: { type: "string" },
					permalink: { type: ["string", "null"] },
				},
				required: [
					"channelId",
					"channel",
					"author",
					"text",
					"reason",
					"action",
					"ts",
					"threadTs",
					"permalink",
				],
				additionalProperties: false,
			},
		},
	},
	required: ["access", "problem", "items"],
	additionalProperties: false,
} as const;

export function slackInboxPrompt(
	now: number,
	dismissed: SlackDismissal[] = [],
): string {
	const since = new Date(now - INBOX_WINDOW_MS).toISOString().slice(0, 10);
	// Older ones are outside the search anyway.
	const skip = dismissed.filter(
		(d) => slackTsMs(d.ts) >= now - INBOX_WINDOW_MS,
	);
	return [
		"Find the Slack messages that need the user to act, using only the Slack tools, which read.",
		"",
		"1. Find the user's own Slack user id (read their profile).",
		`2. Mentions: search for messages that mention the user by name (<@USER_ID>) since ${since}. @here, @channel and group mentions do not count.`,
		`3. DMs: search for direct messages and group DMs sent to the user since ${since}.`,
		"4. Drop anything the user has already answered: a reply from the user later in the thread or DM, or a reaction from the user on the message. Drop messages the user wrote, bots and integrations, and channel joins.",
		"5. Read the thread or DM around each one that is left, and keep it only when the user has to do something: answer a question put to them, decide, review or approve, unblock someone, or do a task asked of them.",
		"   Drop FYI and announcements, thanks and acknowledgements, small talk, questions someone else already answered, requests the author resolved or withdrew, and anything aimed at someone else. When unsure, drop it.",
		...(skip.length
			? [
					"6. Drop these messages the user dismissed, by channel id and ts; a newer message in the same thread or DM still counts:",
					...skip.map((d) => `   - ${d.channelId} ${d.ts}`),
				]
			: []),
		"",
		`Return only those, at most ${SLACK_LIMIT}, one per thread; with more, keep the ${SLACK_LIMIT} most pressing. None is a fine answer.`,
		"- channelId: the channel's id. channel: #name, or for a DM the other person's name.",
		"- author: the display name of who wrote the message.",
		"- text: that message, in one line, user ids replaced by names.",
		"- reason: dm for a direct or group message, otherwise mention.",
		`- action: what the user has to do, starting with a verb, under ${ACTION_MAX} characters, e.g. Answer whether the auth fix shipped, Review Ana's migration PR.`,
		"- ts: the message's ts. threadTs: its thread's root ts (the message's own ts if it is not in a thread).",
		"- permalink: the message's link, or null.",
		"",
		"access: no_access when the Slack tools are missing or fail with an authentication error, with the error in problem; otherwise ok and problem null.",
	].join("\n");
}

/** Slack's ts ("1730000000.123456") as ms since the epoch; 0 when unreadable. */
export function slackTsMs(ts: string): number {
	const seconds = Number.parseFloat(ts);
	return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

function line(text: string, max: number): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * The inbox worker's answer: mentions and DMs that need an action, newest
 * first, one per thread, or why Slack could not be read. Null when the
 * answer is unusable.
 */
export function parseSlackInbox(
	raw: unknown,
): { items: SlackItem[]; error: string | null } | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (r.access === "no_access")
		return {
			items: [],
			error:
				typeof r.problem === "string" && /auth|login|token/i.test(r.problem)
					? SLACK_LOGIN_HINT
					: `Slack: ${line(String(r.problem ?? "no access"), 80)}`,
		};
	if (!Array.isArray(r.items)) return null;
	const byThread = new Map<string, SlackItem>();
	for (const entry of r.items as Array<Record<string, unknown>>) {
		const str = (key: string) =>
			typeof entry?.[key] === "string" ? (entry[key] as string).trim() : "";
		const channelId = str("channelId");
		const ts = str("ts");
		const text = str("text");
		const action = str("action");
		// Only mentions and DMs, and only with something for the user to do.
		const reason = entry.reason;
		if (reason !== "mention" && reason !== "dm") continue;
		if (!channelId || !ts || !text || !action) continue;
		const threadTs = str("threadTs") || ts;
		const item: SlackItem = {
			id: `${channelId}:${threadTs}`,
			channelId,
			channel: str("channel") || channelId,
			author: str("author") || "someone",
			text: line(text, TEXT_MAX),
			reason,
			action: line(action, ACTION_MAX),
			ts,
			threadTs,
			permalink: str("permalink") || null,
			at: slackTsMs(ts),
		};
		const seen = byThread.get(item.id);
		if (!seen || seen.at < item.at) byThread.set(item.id, item);
	}
	const items = [...byThread.values()]
		.sort((a, b) => b.at - a.at)
		.slice(0, SLACK_LIMIT);
	return { items, error: null };
}

// ------------------------------------------------------------ suggestions

const LABEL_MAX = 60;

export const SLACK_SUGGESTION_SCHEMA = {
	type: "object",
	properties: {
		kind: { type: "string", enum: ["reply", "ask", "none"] },
		label: { type: "string" },
		text: { type: ["string", "null"] },
		session: { type: ["string", "null"] },
	},
	required: ["kind", "label", "text", "session"],
	additionalProperties: false,
} as const;

/** A session can be asked when its agent is alive and free: not working, not on a prompt. */
export function askable(s: Session): boolean {
	return (
		!!s.tmuxPane &&
		(s.status === "idle" ||
			s.status === "done" ||
			(s.status === "waiting" && s.waitingOn === "question"))
	);
}

/** What serenity knows that may answer a Slack message: every session, its PR, review requests. */
export function slackContext(
	sessions: Session[],
	reviews: ReviewRequest[],
): string {
	const lines = sessions.map((s) => {
		const parts = [
			`- ${s.name} [${s.topic ?? "unsorted"}] ${s.status}${askable(s) ? " (can be asked)" : ""}`,
		];
		if (s.branch) parts.push(`branch ${s.branch}`);
		parts.push(s.pr ? `${prLine(s)}: ${s.pr.title}` : prLine(s));
		if (s.summary) parts.push(`summary: ${s.summary}`);
		if (s.lastPrompt) parts.push(`task: ${line(s.lastPrompt, 160)}`);
		return parts.join(" · ");
	});
	return [
		"Coding-agent sessions in the user's repo (archived ones are finished):",
		...(lines.length ? lines : ["(none)"]),
		"",
		"Pull requests waiting for the user's review:",
		...(reviews.length
			? reviews.map((r) => `- #${r.number} ${r.title} by ${r.author ?? "?"}`)
			: ["(none)"]),
	].join("\n");
}

/** The answer a session gave to the master's question, for the follow-up. */
export interface SlackAnswer {
	session: string;
	question: string;
	answer: string;
}

export function slackSuggestionPrompt(
	item: SlackItem,
	context: string,
	answer: SlackAnswer | null,
): string {
	return [
		"The user got this Slack message and has not answered it. Help them answer from what serenity, their dashboard of coding-agent sessions, knows.",
		"",
		`Channel: ${item.channel} (id ${item.channelId}), thread ts ${item.threadTs}`,
		`${item.author} wrote: ${item.text}`,
		`What they need from the user: ${item.action}`,
		"",
		"First read the thread with the Slack tools for context. You can also search Slack. You cannot write to Slack.",
		"",
		context,
		...(answer
			? [
					"",
					`You asked the session ${answer.session}: ${answer.question}`,
					`It answered: ${line(answer.answer, 1500)}`,
				]
			: []),
		"",
		"Return one of:",
		"- reply: the sessions, their PRs or the thread hold the answer. text is the reply the user would post in the thread: their voice, short, plain Slack markdown, no greeting. session is the session it draws on, or null.",
		...(answer
			? []
			: [
					'- ask: a session marked "can be asked" most likely knows the answer but its state above does not show it. session is its exact name; text is the question to type to the agent, self-contained, asking for a short answer and no changes.',
				]),
		"- none: nothing in serenity bears on this message (small talk, someone else's question, a meeting).",
		`label: what will happen, under ${LABEL_MAX} characters, e.g. Reply "merged in #42, deploys today", Ask api-auth if the fix shipped.`,
	].join("\n");
}

/** Validates the suggester's answer; null for none or anything that cannot apply. */
export function parseSlackSuggestion(
	raw: unknown,
	item: SlackItem,
	sessions: Session[],
	followUp: boolean,
): SlackSuggestion | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const label = typeof r.label === "string" ? line(r.label, LABEL_MAX) : "";
	const text = typeof r.text === "string" ? r.text.trim() : "";
	if (!label || !text) return null;
	const session = sessions.find((s) => s.name === r.session) ?? null;
	if (r.kind === "reply")
		return {
			itemId: item.id,
			kind: "reply",
			label,
			text,
			sessionId: session?.id ?? null,
			status: "pending",
		};
	if (r.kind === "ask" && !followUp && session && askable(session))
		return {
			itemId: item.id,
			kind: "ask",
			label,
			text,
			sessionId: session.id,
			status: "pending",
		};
	return null;
}

/** The one Slack tool that posts; only `y` on a reply uses it. */
export const SLACK_SEND_TOOL = `mcp__${SLACK_SERVER}__slack_send_message`;

export const SLACK_SEND_SCHEMA = {
	type: "object",
	properties: {
		sent: { type: "boolean" },
		problem: { type: ["string", "null"] },
	},
	required: ["sent", "problem"],
	additionalProperties: false,
} as const;

export function slackSendPrompt(item: SlackItem, text: string): string {
	return [
		`Post a reply in the Slack thread with ts ${item.threadTs} in channel ${item.channelId}, using ${SLACK_SEND_TOOL}.`,
		"Send the text between the markers exactly as written: no changes, no additions.",
		"<<<",
		text,
		">>>",
		"Send it once. Return sent true when the tool succeeded; otherwise sent false and the error in problem.",
	].join("\n");
}

/** Quote markers and whitespace dropped, so a draft shown as a quote block matches what is sent. */
function plain(text: string): string {
	return text
		.replace(/^[ \t]*>[ \t]?/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** The same Slack text, quote markers and whitespace aside. */
export function sameSlackText(a: unknown, b: unknown): boolean {
	return (
		typeof a === "string" &&
		typeof b === "string" &&
		!!plain(a) &&
		plain(a) === plain(b)
	);
}

/**
 * Whether the chat's Slack message was confirmed (ADR 0030): the user's
 * latest message answers a master reply that showed this exact text. Only
 * then is it sent without asking again in NEEDS YOU. `conversation` is the
 * repo's newest messages, oldest first.
 */
export function confirmedSlackSend(
	conversation: MasterMessage[],
	message: unknown,
): boolean {
	if (typeof message !== "string" || !plain(message)) return false;
	const last = conversation.at(-1);
	const draft = conversation.at(-2);
	return (
		last?.from === "you" &&
		draft?.from === "master" &&
		plain(draft.text).includes(plain(message))
	);
}

/**
 * Whether the chat's reply to a session was asked for in the chat (ADR 0035):
 * the user's latest message contains this exact text as whole words, or it
 * answers a master reply that showed it (the Slack check). Only then is it
 * typed into the session without waiting for `y` in NEEDS YOU.
 */
export function confirmedReply(
	conversation: MasterMessage[],
	text: unknown,
): boolean {
	if (typeof text !== "string" || !plain(text)) return false;
	const last = conversation.at(-1);
	if (last?.from !== "you") return false;
	const quoted = plain(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return (
		new RegExp(`(?<!\\w)${quoted}(?!\\w)`).test(plain(last.text)) ||
		confirmedSlackSend(conversation, text)
	);
}

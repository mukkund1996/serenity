import type { MasterMessage, Session } from "./domain";
import { prLine } from "./master";
import type { ReviewRequest } from "./pr";
import { findSessionByName } from "./session-name";

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
 * The master's proposal for one Slack item (ADR 0024, 0050): a reply to post
 * in its thread or DM, a message to the session it is about, or a new
 * session to do what it asks. Nothing runs until the user presses y.
 */
export interface SlackSuggestion {
	itemId: string;
	kind: SlackSuggestionKind;
	/**
	 * What y does, as a verb and its target: "Reply in #eng thread", "Tell
	 * api-auth", "Start new session fix-login". Once acted on, what it waits on.
	 */
	action: string;
	/** The reply to post, the message to type to the session, or the new session's brief. */
	text: string;
	/**
	 * The session told (tell), the one a reply draws on, or the one started
	 * (start, once y ran); null if none.
	 */
	sessionId: string | null;
	/** start: the new session's name. */
	name: string | null;
	/**
	 * "asked": the message or brief went to the session and its answer is
	 * awaited. "sending": the reply is being posted.
	 */
	status: "pending" | "asked" | "sending";
}

export type SlackSuggestionKind = "reply" | "tell" | "start";

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
					lastOwnTs: { type: ["string", "null"] },
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
					"lastOwnTs",
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
		"- lastOwnTs: the ts of the user's newest message where they would have seen this one, or null if none: for a DM, anything the user wrote in that DM; for a message in a thread, the user's newest reply in that thread; otherwise the user's newest top-level message in that channel.",
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
 * answer is unusable. A message the user wrote after, where they would have
 * seen it (`lastOwnTs`), means they read it on Slack (ADR 0050): it is left out.
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
		if (slackTsMs(str("lastOwnTs")) > slackTsMs(ts)) continue;
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

const NAME_MAX = 40;

export const SLACK_SUGGESTION_SCHEMA = {
	type: "object",
	properties: {
		kind: { type: "string", enum: ["reply", "tell", "start", "none"] },
		text: { type: ["string", "null"] },
		session: { type: ["string", "null"] },
		name: { type: ["string", "null"] },
	},
	required: ["kind", "text", "session", "name"],
	additionalProperties: false,
} as const;

/** A session can be told something when its agent is alive and free: not working, not on a prompt. */
export function askable(s: Session): boolean {
	return (
		!!s.tmuxPane &&
		(s.status === "idle" ||
			s.status === "done" ||
			(s.status === "waiting" && s.waitingOn === "question"))
	);
}

/**
 * Sessions a Slack message names: by session name, branch, or PR (number or
 * link). The suggester checks these first; it can still pick another.
 */
export function relatedSessions(
	item: SlackItem,
	sessions: Session[],
): Session[] {
	const haystack = `${item.text}\n${item.action}`.toLowerCase();
	const word = (w: string) =>
		new RegExp(
			`(?<![\\w-])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
		).test(haystack);
	return sessions.filter(
		(s) =>
			word(s.name) ||
			(!!s.branch && word(s.branch)) ||
			(!!s.pr &&
				(word(`#${s.pr.number}`) || haystack.includes(`/pull/${s.pr.number}`))),
	);
}

/** What serenity knows that may answer a Slack message: every session, its PR, review requests. */
export function slackContext(
	sessions: Session[],
	reviews: ReviewRequest[],
	item?: SlackItem,
): string {
	const lines = sessions.map((s) => {
		const parts = [
			`- ${s.name} [${s.topic ?? "unsorted"}] ${s.status}${askable(s) ? " (can be told)" : ""}`,
		];
		if (s.branch) parts.push(`branch ${s.branch}`);
		parts.push(s.pr ? `${prLine(s)}: ${s.pr.title} ${s.pr.url}` : prLine(s));
		if (s.summary) parts.push(`summary: ${s.summary}`);
		if (s.lastPrompt) parts.push(`task: ${line(s.lastPrompt, 160)}`);
		return parts.join(" · ");
	});
	const related = item ? relatedSessions(item, sessions) : [];
	return [
		"Coding-agent sessions in the user's repo (archived ones are finished):",
		...(lines.length ? lines : ["(none)"]),
		...(related.length
			? [
					"",
					`The message names these sessions by name, branch or PR: ${related.map((s) => s.name).join(", ")}.`,
				]
			: []),
		"",
		"Pull requests waiting for the user's review:",
		...(reviews.length
			? reviews.map((r) => `- #${r.number} ${r.title} by ${r.author ?? "?"}`)
			: ["(none)"]),
	].join("\n");
}

/** The answer a session gave to the master's message or brief, for the follow-up. */
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
		"The user got this Slack message and has not answered it. Propose the one follow-up that helps most, from what serenity, their dashboard of coding-agent sessions, knows.",
		"",
		`Channel: ${item.channel} (id ${item.channelId}), thread ts ${item.threadTs}`,
		`${item.author} wrote: ${item.text}`,
		`What they need from the user: ${item.action}`,
		"",
		"First read the thread with the Slack tools for context. You can also search Slack. You cannot write to Slack.",
		"",
		"Match the message to a session: a session it names, one whose branch, PR or summary covers what it is about, or one whose task it follows up. Check the PR links and numbers in the thread too.",
		"",
		context,
		...(answer
			? [
					"",
					`You sent the session ${answer.session}: ${line(answer.question, 600)}`,
					`It answered: ${line(answer.answer, 1500)}`,
				]
			: []),
		"",
		"Return one of:",
		"- reply: the sessions, their PRs or the thread already hold the answer. text is the reply the user would post: their voice, short, plain Slack markdown, no greeting. session is the session it draws on, or null.",
		...(answer
			? []
			: [
					'- tell: a session marked "can be told" is about this message, and either knows the answer but its state above does not show it, or should do what the message asks (a fix or change in its own work). session is its exact name; text is the message to type to its agent, self-contained: say what was asked on Slack and by whom, and what you want back (a short answer, or the change and a one-line report).',
					"- start: the message asks for new work that no session covers (a bug to fix, a change to make, something to investigate). name is the new session's name, lowercase words joined by hyphens, at most 3 words, e.g. fix-login-redirect. text is its brief: what to do, what was asked on Slack and by whom, and the message's link, self-contained.",
				]),
		"- none: nothing in serenity bears on this message and no session should act on it (small talk, someone else's question, a meeting).",
		"Prefer reply when you can answer, then tell, then start. Set unused fields to null.",
	].join("\n");
}

/** A session name from the suggester: lowercase words joined by hyphens; null when nothing is left. */
export function slackSessionName(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const name = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, NAME_MAX)
		.replace(/-+$/, "");
	return name || null;
}

/** Where y on a reply posts it: the DM itself, or the item's thread. */
export function slackReplyTarget(item: SlackItem): string {
	if (item.reason === "dm")
		return item.threadTs === item.ts
			? `Reply to ${item.channel} in DM`
			: `Reply in DM thread with ${item.channel}`;
	return `Reply in ${item.channel} thread`;
}

/**
 * A Slack suggestion's ◆ line (ADR 0050): what y does and its text while
 * pending ("Reply in #eng thread: merged in #42"), else what it waits on.
 */
export function slackSuggestionLine(g: SlackSuggestion): string {
	if (g.status === "sending") return "Sending to Slack…";
	if (g.status === "asked") return g.action;
	return `${g.action}: ${g.text}`;
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
	const text = typeof r.text === "string" ? r.text.trim() : "";
	if (!text) return null;
	const session = findSessionByName(sessions, r.session) ?? null;
	const base = {
		itemId: item.id,
		text,
		name: null,
		status: "pending" as const,
	};
	if (r.kind === "reply")
		return {
			...base,
			kind: "reply",
			action: slackReplyTarget(item),
			sessionId: session?.id ?? null,
		};
	if (followUp) return null;
	if (r.kind === "tell" && session && askable(session))
		return {
			...base,
			kind: "tell",
			action: `Tell ${session.name}`,
			sessionId: session.id,
		};
	const name = slackSessionName(r.name);
	if (r.kind === "start" && name)
		return {
			...base,
			kind: "start",
			action: `Start new session ${name}`,
			sessionId: null,
			name,
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
	// A DM's own message is answered in the DM; anything else in its thread.
	const where =
		item.reason === "dm" && item.threadTs === item.ts
			? `Post a message in the Slack DM channel ${item.channelId}, not in a thread, using ${SLACK_SEND_TOOL}.`
			: `Post a reply in the Slack thread with ts ${item.threadTs} in channel ${item.channelId}, using ${SLACK_SEND_TOOL}.`;
	return [
		where,
		"Send the text between the markers exactly as written: no changes, no additions.",
		"<<<",
		text,
		">>>",
		"Send it once. Return sent true when the tool succeeded; otherwise sent false and the error in problem.",
	].join("\n");
}

/** Slack's two-step file upload (ADR 0049); serenity POSTs the bytes in between. */
export const SLACK_UPLOAD_URL_TOOL = `mcp__${SLACK_SERVER}__slack_get_file_upload_url`;
export const SLACK_COMPLETE_UPLOAD_TOOL = `mcp__${SLACK_SERVER}__slack_complete_file_upload`;

export const SLACK_UPLOAD_URL_SCHEMA = {
	type: "object",
	properties: {
		upload_url: { type: ["string", "null"] },
		file_id: { type: ["string", "null"] },
		problem: { type: ["string", "null"] },
	},
	required: ["upload_url", "file_id", "problem"],
	additionalProperties: false,
} as const;

export function slackUploadUrlPrompt(filename: string, bytes: number): string {
	return [
		`Call ${SLACK_UPLOAD_URL_TOOL} once, with filename ${JSON.stringify(filename)} and content_length ${bytes}. Nothing else.`,
		"Return upload_url and file_id exactly as the tool returned them, byte for byte: don't decode, encode or retype any part. If it failed, both null and the error in problem.",
	].join("\n");
}

export const SLACK_COMPLETE_UPLOAD_SCHEMA = {
	type: "object",
	properties: {
		shared: { type: "boolean" },
		permalink: { type: ["string", "null"] },
		problem: { type: ["string", "null"] },
	},
	required: ["shared", "permalink", "problem"],
	additionalProperties: false,
} as const;

/** Where a file goes and what goes with it; the user confirmed all of it. */
export interface SlackFileShare {
	fileId: string;
	channelId: string;
	threadTs: string | null;
	title: string;
	comment: string | null;
}

export function slackCompleteUploadPrompt(share: SlackFileShare): string {
	const args = [
		`file_id ${JSON.stringify(share.fileId)}`,
		`channel_id ${JSON.stringify(share.channelId)}`,
		`title ${JSON.stringify(share.title)}`,
		...(share.threadTs ? [`thread_ts ${JSON.stringify(share.threadTs)}`] : []),
	];
	return [
		`Call ${SLACK_COMPLETE_UPLOAD_TOOL} once, with ${args.join(", ")}${share.comment ? ", and initial_comment set to the text between the markers, exactly as written: no changes, no additions." : ". No initial_comment."}`,
		...(share.comment ? ["<<<", share.comment, ">>>"] : []),
		"Return shared true and the file's link when the tool succeeded; otherwise shared false and the error in problem.",
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

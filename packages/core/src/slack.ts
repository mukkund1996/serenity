/**
 * Slack for the master (ADR 0023): the threads and mentions still waiting on
 * the user, read through Slack's MCP server by a one-shot `claude -p`. Pure:
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

/** Items shown at most; `[` `]` cycle through them. */
export const SLACK_LIMIT = 5;
const TEXT_MAX = 200;

export type SlackReason = "mention" | "thread";

/** One mention or thread reply the user has not answered yet. */
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
	/** The waiting message's ts. */
	ts: string;
	/** The thread's root ts; the message's own when it starts the thread. */
	threadTs: string;
	permalink: string | null;
	/** When the waiting message was posted, ms since the epoch. */
	at: number;
}

/** What a map of a repo with Slack enabled shows. */
export interface SlackState {
	/** Newest first, at most SLACK_LIMIT. */
	items: SlackItem[];
	/** Why Slack could not be read (no login, a failed call), or null. */
	error: string | null;
	/** When Slack was last read; null before the first read. */
	checkedAt: number | null;
}

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
					reason: { type: "string", enum: ["mention", "thread"] },
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

export function slackInboxPrompt(now: number): string {
	const since = new Date(now - 7 * 24 * 3600_000).toISOString().slice(0, 10);
	return [
		"Find the Slack messages still waiting on the user, using only the Slack tools, which read.",
		"",
		"1. Find the user's own Slack user id (read their profile).",
		`2. Mentions: search for messages that mention the user (<@USER_ID>) since ${since}.`,
		`3. Threads: search for thread replies the user wrote since ${since}; read each such thread and keep it when someone else replied after the user's last reply.`,
		"4. Drop anything the user has already answered: a reply from the user later in the same thread, or a reaction from the user on the message. Drop messages the user wrote, bots, and channel joins.",
		"",
		`Return at most ${SLACK_LIMIT} items, newest first, one per thread:`,
		"- channelId: the channel's id. channel: #name, or the DM's name.",
		"- author: the display name of who wrote the waiting message.",
		"- text: that message, in one line, user ids replaced by names.",
		"- reason: mention when it mentions the user, otherwise thread.",
		"- ts: the waiting message's ts. threadTs: its thread's root ts (the message's own ts if it is not in a thread).",
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
 * The inbox worker's answer: items, newest first, one per thread, or why
 * Slack could not be read. Null when the answer is unusable.
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
		if (!channelId || !ts || !text) continue;
		const threadTs = str("threadTs") || ts;
		const item: SlackItem = {
			id: `${channelId}:${threadTs}`,
			channelId,
			channel: str("channel") || channelId,
			author: str("author") || "someone",
			text: line(text, TEXT_MAX),
			reason: entry.reason === "mention" ? "mention" : "thread",
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

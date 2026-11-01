/**
 * The demos' made-up world (the README GIF and the docs page's GIFs): one
 * repo, a handful of sessions, a couple of Slack messages and the master's
 * scripted chat. Every name, channel and message here is fiction, so a
 * recording leaks nothing real. `agent.ts` (the fake claude) and `demo.ts`
 * (the driver) both read it.
 */

export const REPO = "acme-shop";

export interface DemoSession {
	name: string;
	/** The topic the fake summarizer files it under. */
	topic: string;
	/** Its first prompt; the session starts working on it. */
	brief: string;
	/** What it says when it pauses before the recording starts (becomes its summary). */
	progress: string;
	/** Finished before the recording: it stays idle with a ✓. */
	done?: boolean;
	/** What it answers when the master tells it something. */
	answer?: string;
	/** A PR the fake gh reports for its branch. */
	pr?: { number: number; checks: "SUCCESS" | "PENDING" };
}

export const SESSIONS: DemoSession[] = [
	{
		name: "checkout-retry",
		topic: "checkout",
		brief: "Retry failed card payments once before showing an error",
		progress: "Added a single retry around the card charge; writing tests.",
		pr: { number: 214, checks: "PENDING" },
	},
	{
		name: "cart-badge",
		topic: "checkout",
		brief: "Show the item count on the cart icon",
		progress: "Cart badge renders the count; wiring it to live updates.",
		answer:
			"Not yet: the count updates on page load; live updates land in my next commit.",
	},
	{
		name: "db-migration",
		topic: "orders db",
		brief: "Add an index on orders.created_at and migrate",
		progress: "Wrote the migration for the orders index; ready to run it.",
	},
	{
		name: "search-typos",
		topic: "search",
		brief: "Make product search tolerate one typo",
		progress: "Fuzzy matching in place; checking ranking on the sample data.",
	},
	{
		name: "price-filter",
		topic: "search",
		brief: "Add a min/max price filter to search results",
		progress: "Filter UI done; deciding how to round prices in the URL.",
	},
	{
		name: "flaky-e2e",
		topic: "ci",
		brief: "Find out why the checkout e2e test fails one run in ten",
		progress:
			"Done: fixed the race on the payment iframe; e2e passes 50 of 50 runs.",
		done: true,
		answer:
			"Done: the flake is fixed in PR #211 (50 of 50 runs pass); a rebase on main picks it up.",
		pr: { number: 211, checks: "SUCCESS" },
	},
];

/** Sessions the master starts on camera (`@new` in the mentions GIF), not by `demo.ts start`. */
export const LATER_SESSIONS: DemoSession[] = [
	{
		name: "wishlist",
		topic: "checkout",
		brief: "Add a wishlist page: a heart on each product saves it to the list",
		progress: "",
	},
];

/** What happens during the recording, in order, `at` ms after it starts. */
export type DemoEvent =
	| { at: number; kind: "permission"; session: string; command: string }
	| { at: number; kind: "ask"; session: string; question: string }
	| { at: number; kind: "slack"; item: DemoSlackItem };

export interface DemoSlackItem {
	channel: string;
	author: string;
	text: string;
	action: string;
	reason: "mention" | "dm";
	/** The master's proposal for it. */
	suggestion:
		| { kind: "reply"; text: string }
		| {
				kind: "tell";
				session: string;
				text: string;
				/** The reply once the session has answered. */
				reply: string;
		  };
}

/** The README GIF's timeline. */
export const TIMELINE: DemoEvent[] = [
	{
		at: 3_000,
		kind: "permission",
		session: "db-migration",
		command: "bun run db:migrate",
	},
	{
		at: 7_000,
		kind: "slack",
		item: {
			channel: "#release",
			author: "Priya",
			text: "is the checkout retry going out in today's release?",
			action: "Say whether checkout-retry ships today",
			reason: "mention",
			suggestion: {
				kind: "reply",
				text: "Yes: PR #214 is in review, it ships with the 3pm release.",
			},
		},
	},
	{
		at: 11_000,
		kind: "ask",
		session: "price-filter",
		question: "Should prices in the URL be whole euros or cents?",
	},
	{
		at: 14_000,
		kind: "slack",
		item: {
			channel: "Sam",
			author: "Sam",
			text: "checkout e2e failed on my branch again, is the flake fixed?",
			action: "Say whether the checkout e2e flake is fixed",
			reason: "dm",
			suggestion: {
				kind: "tell",
				session: "flaky-e2e",
				text: "Sam asks on Slack whether the checkout e2e flake is fixed; their branch failed. Reply in one line.",
				reply:
					"Yes, fixed in #211 (50 of 50 runs green). Rebase on main and it'll pass.",
			},
		},
	},
];

const [migrate, slackMention, priceQuestion] = TIMELINE as [
	DemoEvent,
	DemoEvent,
	DemoEvent,
];

/**
 * Each GIF's timeline, by the name `demo.ts play <name>` takes. The docs
 * GIFs (website/docs/media) start once these have played, so NEEDS YOU is
 * already full when the recording shows.
 */
export const TIMELINES: Record<string, DemoEvent[]> = {
	readme: TIMELINE,
	map: [],
	sessions: [],
	"needs-you": [
		{ ...migrate, at: 0 },
		{ ...priceQuestion, at: 400 },
		{ ...slackMention, at: 800 },
	],
	master: [
		{ ...migrate, at: 0 },
		{ ...priceQuestion, at: 400 },
	],
	mentions: [],
};

/** A turn of the master's scripted chat (the mentions and master GIFs). */
export interface DemoChatTurn {
	/** Matches the user's words, or the whole message when serenity sends it. */
	when: RegExp;
	/** The serenity tools it calls first, as the real master does over MCP. */
	tools?: { name: string; args: Record<string, unknown> }[];
	reply: string;
}

export const CHAT: DemoChatTurn[] = [
	{
		when: /waiting on me|needs? me/i,
		reply:
			"Two: db-migration wants to run bun run db:migrate, just the new orders index, so I'd approve it. price-filter asks euros or cents; I suggested cents.",
	},
	{
		when: /^@cart-badge\b/,
		tools: [
			{
				name: "send_reply",
				args: {
					session: "cart-badge",
					text: "Does the cart badge update live yet? Answer in one line.",
				},
			},
			{
				name: "watch_session",
				args: {
					session: "cart-badge",
					note: "Relay its answer to the user in one line.",
				},
			},
		],
		reply: "Asked cart-badge; I'll relay its answer.",
	},
	{
		when: /cart-badge[\s\S]*live updates land/,
		reply:
			"cart-badge: not live yet. The count updates on page load; live updates land in its next commit.",
	},
	{
		when: /^@new\b.*wishlist/,
		tools: [
			{
				name: "create_session",
				args: {
					name: "wishlist",
					topic: "checkout",
					prompt:
						"Add a wishlist page: a heart on each product saves it to the list",
				},
			},
		],
		reply: "Started wishlist under checkout.",
	},
];

/** The session a worker prompt is about, from its "Session: <name>" line. */
export function sessionIn(prompt: string): DemoSession | undefined {
	const name = prompt.match(/^Session: (\S+)/m)?.[1];
	return [...SESSIONS, ...LATER_SESSIONS].find((s) => s.name === name);
}

/**
 * The setup steps of onboarding (ADR 0065): logins serenity uses but does
 * not own. Each step is one entry in SETUP_STEPS; the first-boot Setup panel,
 * the settings panel and `serenity doctor` all list them from here. Pure:
 * the texts, the status shape, and parsing what `gh` and `claude` print.
 * Serenity never sees a token: gh and Claude Code keep their own.
 */

export type SetupStepId = "github" | "slack";

/** One step's state, as the daemon checks it. */
export interface SetupStatus {
	id: SetupStepId;
	/** Logged in (GitHub), or logged in to Slack's MCP server (Slack). */
	connected: boolean;
	/** Who: the GitHub login, the Slack name once a read knows it. */
	user: string | null;
	/** Slack only: whether this repo's map shows Slack (`slack.repos`). */
	on?: boolean;
	/** Why it is not connected, or what failed, in one line. */
	problem: string | null;
}

export interface SetupStep {
	id: SetupStepId;
	title: string;
	/** What it enables, one short line each. */
	enables: string[];
	/** What doesn't work without it. */
	without: string;
	/** Where to read more, if anywhere. */
	link?: string;
	/** The command that runs the step in a terminal. */
	command: string;
}

/** The steps, in the order the Setup panel shows them. Add a step here. */
export const SETUP_STEPS: SetupStep[] = [
	{
		id: "github",
		title: "GitHub",
		enables: [
			"PR badges and checks on cards, and adding reviewers",
			"the master's overview of the repo's PRs",
			"crash reports filed as issues, if you turn them on",
		],
		without: "Without it, cards show no PRs and the master can't see them.",
		command: "serenity setup github",
	},
	{
		id: "slack",
		title: "Slack",
		enables: [
			"your mentions and DMs that need you, in NEEDS YOU",
			"replies the master drafts; nothing is sent until you press y",
			"sharing handover docs to a thread",
		],
		without: "Off by default: without it, serenity never reads Slack.",
		link: "https://github.com/mukkund1996/serenity/blob/main/PRIVACY.md#what-is-sent-and-where",
		command: "serenity setup slack",
	},
];

export const setupStep = (id: SetupStepId): SetupStep =>
	SETUP_STEPS.find((s) => s.id === id) as SetupStep;

/**
 * One line for a status: "connected as sam", "not connected", or the
 * problem. Slack adds whether it is on for this repo.
 */
export function describeSetupStatus(status: SetupStatus): string {
	const who = status.connected
		? status.user
			? `connected as ${status.user}`
			: "connected"
		: (status.problem ?? "not connected");
	if (status.on === undefined) return who;
	return `${who} · ${status.on ? "on" : "off"} for this repo`;
}

/** Whether there is nothing left to do for the step. */
export const setupDone = (status: SetupStatus): boolean =>
	status.connected && status.on !== false;

/**
 * The account `gh auth status` reports for github.com, or null. Newer gh
 * prints "Logged in to github.com account <login>", older "as <login>".
 */
export function parseGhAuthStatus(text: string): string | null {
	const match = text.match(
		/Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/,
	);
	return match?.[1] ?? null;
}

/** What `claude mcp get <server>` says about the server's login. */
export type McpLogin = "connected" | "needs-login" | "missing" | "failed";

/**
 * Reads `claude mcp get`'s output (exit code and text): "Status: ✓
 * Connected", "! Needs authentication", "✗ Failed to connect", or no such
 * server.
 */
export function parseMcpGet(ok: boolean, text: string): McpLogin {
	if (!ok || /No MCP server found/i.test(text)) return "missing";
	const status = text.match(/Status:\s*(.*)/)?.[1] ?? "";
	if (/Connected/i.test(status)) return "connected";
	if (/auth/i.test(status)) return "needs-login";
	return "failed";
}

/**
 * The setup steps of onboarding (ADR 0065, 0066): logins serenity uses but does
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
	/** What it gives, in one short line. */
	gives: string;
	/** A privacy note, one line, with `link` behind `o`. */
	note?: string;
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
		gives: "PRs and checks on your cards",
		command: "serenity setup github",
	},
	{
		id: "slack",
		title: "Slack",
		gives: "Mentions and DMs that need you, in NEEDS YOU",
		note: "Nothing is sent until you press y",
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

/**
 * The first-boot panel's import step (ADR 0066). Not in SETUP_STEPS: it is
 * no login, so doctor and the settings panel don't list it.
 */
export const IMPORT_STEP = {
	title: "Import",
	gives: "Past Claude sessions here, parked until you resume one",
} as const;

/** How many of the newest past sessions the import step lists. */
export const IMPORT_PREVIEW = 3;

/** "3 optional steps." for the panel's intro. */
export function setupIntro(steps: number): string {
	const words = ["No", "One", "Two", "Three", "Four", "Five"];
	const n = words[steps] ?? String(steps);
	return `${n} optional ${steps === 1 ? "step" : "steps"}. More: getserenity.dev/docs`;
}

/** The import step's status line: what was found, or what happened to it. */
export function importSummary(
	found: number,
	days: number,
	state: "todo" | "done" | "skipped",
	imported = 0,
): string {
	if (state === "done") return `imported ${imported}`;
	if (state === "skipped") return "skipped";
	return `${found} past ${found === 1 ? "session" : "sessions"}, last ${days} days`;
}

/**
 * Where a step's Enter or s goes next: the first step after `at` still to
 * do, else any before it, else `count`, the "You're set" line.
 */
export function nextOpenStep(open: boolean[], at: number): number {
	const after = open.findIndex((o, i) => o && i > at);
	if (after >= 0) return after;
	const before = open.findIndex((o, i) => o && i !== at);
	return before >= 0 ? before : open.length;
}

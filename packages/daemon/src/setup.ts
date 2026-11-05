import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import {
	type McpLogin,
	parseGhAuthStatus,
	parseMcpGet,
	type SetupStatus,
	SLACK_SERVER,
} from "@serenity/core";

/**
 * The setup steps' checks (ADR 0065), shared by the daemon (the Setup and
 * settings panels) and the CLI (`serenity doctor`, `serenity setup`). They
 * only ask gh and claude what they know; neither prints a token here.
 */

const CHECK_TIMEOUT_MS = 15_000;

interface Output {
	ok: boolean;
	text: string;
	/** The command could not start: not installed. */
	missing: boolean;
}

function run(command: string[], cwd?: string): Promise<Output> {
	return new Promise((resolve) => {
		let text = "";
		let done = false;
		const finish = (out: Output) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(out);
		};
		const child = spawn(command[0] as string, command.slice(1), {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
		});
		const timer = setTimeout(() => {
			child.kill();
			finish({ ok: false, text: "timed out", missing: false });
		}, CHECK_TIMEOUT_MS);
		child.stdout.on("data", (d) => {
			text += d;
		});
		child.stderr.on("data", (d) => {
			text += d;
		});
		child.on("error", () => finish({ ok: false, text: "", missing: true }));
		child.on("close", (code) =>
			finish({ ok: code === 0, text: text.trim(), missing: false }),
		);
	});
}

/** GitHub: `gh auth status` for github.com, and the account it names. */
export async function githubStatus(
	gh = process.env.SERENITY_GH_BIN ?? "gh",
): Promise<SetupStatus> {
	const out = await run([gh, "auth", "status", "--hostname", "github.com"]);
	const user = parseGhAuthStatus(out.text);
	if (out.ok) return { id: "github", connected: true, user, problem: null };
	return {
		id: "github",
		connected: false,
		user: null,
		problem: out.missing
			? "gh is not installed (brew install gh)"
			: "not logged in",
	};
}

export interface SlackCheck {
	/** The `claude` command. */
	claude: string[];
	/** serenity's workers folder, where the Slack server is registered (ADR 0023). */
	workers: string;
	/** Whether this repo's map shows Slack. */
	on: boolean;
	/** The name the last inbox read found, if any. */
	user: string | null;
}

/** Whether Slack's MCP server is registered and logged in, for the workers folder. */
export async function slackLogin(
	claude: string[],
	workers: string,
): Promise<{ login: McpLogin; text: string }> {
	mkdirSync(workers, { recursive: true });
	const out = await run([...claude, "mcp", "get", SLACK_SERVER], workers);
	if (out.missing) return { login: "failed", text: "claude is not installed" };
	return { login: parseMcpGet(out.ok, out.text), text: out.text };
}

/** Slack: logged in to its MCP server, and on for this repo or not. */
export async function slackStatus(check: SlackCheck): Promise<SetupStatus> {
	const { login, text } = await slackLogin(check.claude, check.workers);
	const base = { id: "slack" as const, on: check.on };
	if (login === "connected")
		return { ...base, connected: true, user: check.user, problem: null };
	return {
		...base,
		connected: false,
		user: null,
		problem:
			login === "missing"
				? "not connected"
				: login === "needs-login"
					? "needs a login"
					: `can't reach Slack: ${
							text
								.split("\n")
								.find((l) => /Status/.test(l))
								?.replace(/.*Status:\s*/, "") ?? text.slice(0, 60)
						}`,
	};
}

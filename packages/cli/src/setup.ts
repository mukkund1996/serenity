import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import {
	describeSetupStatus,
	loadConfig,
	type SetupStatus,
	type SetupStepId,
	SLACK_SERVER,
	setupStep,
} from "@serenity/core";
import { askYes, setSlack, slackIsOn, turnOnHint } from "./slack";

/**
 * `serenity setup github|slack` (ADR 0065): one login step in the terminal.
 * The Setup and settings panels run it in a tmux popup (`--popup`); it works
 * the same from a shell. The logins are gh's and Claude Code's own, so their
 * tokens stay in their stores and never pass through serenity.
 */

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

export interface SetupOptions {
	home: string;
	/** The repo to turn Slack on for; none outside a repo. */
	repo: string | null;
	/** Run in the panels' popup: pause before it closes. */
	popup: boolean;
}

function intro(id: SetupStepId): void {
	const step = setupStep(id);
	console.log(bold(step.title));
	for (const line of step.enables) console.log(`  · ${line}`);
	if (step.link)
		console.log(dim(`  What serenity reads and sends: ${step.link}`));
	console.log("");
}

function result(status: SetupStatus): void {
	const line = describeSetupStatus(status);
	console.log(status.connected ? green(`✓ ${line}`) : yellow(`! ${line}`));
}

/** Waits for Enter, so a popup's error stays readable. */
function pause(): void {
	process.stdout.write(dim("\nPress Enter to go back."));
	spawnSync("sh", ["-c", "read _"], { stdio: "inherit" });
}

async function finish(status: SetupStatus, popup: boolean): Promise<number> {
	result(status);
	if (popup) {
		if (status.connected) await Bun.sleep(1500);
		else pause();
	}
	return status.connected ? 0 : 1;
}

export async function setupGithub(opts: SetupOptions): Promise<number> {
	const { githubStatus } = await import("@serenity/daemon");
	intro("github");
	const before = await githubStatus();
	if (before.connected) return finish(before, opts.popup);
	if (before.problem?.includes("not installed")) {
		console.log("Install the GitHub CLI first: https://cli.github.com");
		return finish(before, opts.popup);
	}
	console.log("Logging in with gh. Your token stays with gh.\n");
	spawnSync(
		process.env.SERENITY_GH_BIN ?? "gh",
		["auth", "login", "--hostname", "github.com", "--web"],
		{ stdio: "inherit" },
	);
	console.log("");
	return finish(await githubStatus(), opts.popup);
}

/**
 * Slack (ADR 0023): its MCP server is registered for serenity's workers
 * folder only, `claude mcp login` signs in, and the repo gets Slack on.
 */
export async function setupSlack(opts: SetupOptions): Promise<number> {
	const { slackLogin, slackStatus } = await import("@serenity/daemon");
	const claude = process.env.SERENITY_CLAUDE_BIN ?? "claude";
	const workers = join(opts.home, "workers");
	intro("slack");
	const run = (args: string[], stdio: "inherit" | "pipe" = "inherit") =>
		spawnSync(claude, args, { cwd: workers, stdio, encoding: "utf8" });
	const { login } = await slackLogin([claude], workers);
	if (login !== "connected") {
		const config = loadConfig();
		// Replaced, so a changed `slack.mcp` in the config takes effect.
		run(["mcp", "remove", "-s", "local", SLACK_SERVER], "pipe");
		const added = run(
			[
				"mcp",
				"add-json",
				"-s",
				"local",
				SLACK_SERVER,
				JSON.stringify(config.slack.mcp),
			],
			"pipe",
		);
		if (added.status !== 0) {
			console.log(`Could not register Slack's MCP server: ${added.stderr}`);
		} else if (config.slack.mcp.type === "stdio") {
			console.log("A stdio server signs in through its own settings.");
		} else {
			console.log(
				"Logging in to Slack through Claude Code. Your token stays with Claude Code.\n",
			);
			// Over SSH no browser opens here: print the link instead.
			run([
				"mcp",
				"login",
				...(process.env.SSH_CONNECTION ? ["--no-browser"] : []),
				SLACK_SERVER,
			]);
			console.log("");
		}
	}
	const after = await slackLogin([claude], workers);
	if (after.login === "connected" && opts.repo && !slackIsOn(opts.repo)) {
		// From the panels, connecting means "for this repo"; in a shell, ask.
		const yes =
			opts.popup ||
			(await askYes(`Show Slack on ${basename(opts.repo)}'s map now?`));
		if (yes)
			await setSlack(opts.home, opts.repo, true).catch((e: Error) =>
				console.log(`Could not turn Slack on: ${e.message}`),
			);
	}
	const on = opts.repo ? slackIsOn(opts.repo) : undefined;
	const status = await slackStatus({
		claude: [claude],
		workers,
		on: !!on,
		user: null,
	});
	if (on === undefined) delete status.on;
	if (status.connected && !on) console.log(turnOnHint(opts.repo, true));
	return finish(status, opts.popup);
}

/** `serenity doctor`'s account lines: who gh and Slack are logged in as. */
export async function accountLines(home: string, repo: string | null) {
	const { githubStatus, slackStatus } = await import("@serenity/daemon");
	const slackOnHere = !!repo && slackIsOn(repo);
	const [github, slack] = await Promise.all([
		githubStatus(),
		slackStatus({
			claude: [process.env.SERENITY_CLAUDE_BIN ?? "claude"],
			workers: join(home, "workers"),
			on: slackOnHere,
			user: null,
		}),
	]);
	if (!repo) delete slack.on;
	return [github, slack].map((status) => ({
		status,
		line: `${describeSetupStatus(status)}${
			status.connected && status.on !== false
				? ""
				: dim(` · ${setupStep(status.id).command}`)
		}`,
	}));
}

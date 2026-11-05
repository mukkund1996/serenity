import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import {
	configPath,
	connectDaemon,
	loadConfig,
	repoKey,
	writeConfig,
} from "@serenity/core";

export const SLACK_USAGE = `usage:
  serenity slack login          sign in to Slack for the master (once)
  serenity slack on [repo]      show Slack on this repo's map
  serenity slack off [repo]     hide it again
  serenity slack status [repo]  is Slack on for this repo?
[repo] defaults to the git repo you are in.`;

/** The top of the git repo at `dir`, or null when it is not in one. */
export function gitRoot(dir = process.cwd()): string | null {
	const result = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
	});
	return result.status === 0 ? repoKey(result.stdout.trim()) : null;
}

export function slackIsOn(repo: string, file = configPath()): boolean {
	return loadConfig(file).slack.repos.includes(repoKey(repo));
}

/** How to turn Slack on, said to someone who has it off for `repo`. */
export function turnOnHint(repo: string | null, connected = false): string {
	const state = connected
		? "Slack is connected but turned off"
		: "Slack is off";
	return repo
		? `${state} for ${basename(repo)}. Turn it on with \`serenity slack on\` in the repo, or Ctrl+, → Slack in its map.`
		: `${state} for every repo. Turn it on for one with \`serenity slack on\` inside it, or Ctrl+, → Slack in its map.`;
}

/**
 * Turns Slack on or off for `repo`. With the daemon up, it saves through the
 * daemon like the settings panel does, so the map changes at once; without
 * it, it writes config.json the same way and the daemon reads it on start.
 * Returns when the change takes effect.
 */
export async function setSlack(
	home: string,
	repo: string,
	on: boolean,
	file = configPath(),
): Promise<string> {
	const change = { key: "slack", repo: repoKey(repo), value: on } as const;
	const peer = await connectDaemon(home);
	if (peer)
		try {
			const { applies } = await peer.request(
				"config.set",
				{ repo: change.repo, change },
				{ timeoutMs: 5000 },
			);
			return applies;
		} finally {
			peer.close();
		}
	writeConfig([change], file);
	return "the map shows it next time you run serenity";
}

/** Asks a yes/no question on the terminal; Enter means yes. */
export async function askYes(question: string): Promise<boolean> {
	if (!process.stdin.isTTY) return false;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await new Promise<string>((done) =>
		rl.question(`${question} [Y/n] `, done),
	);
	rl.close();
	return !/^\s*n/i.test(answer);
}

/**
 * `serenity slack on|off|status [repo]`. Returns the exit code.
 */
export async function runSlackCommand(
	home: string,
	sub: string,
	target: string | undefined,
	file = configPath(),
): Promise<number> {
	const repo = gitRoot(target ?? process.cwd());
	if (!repo) {
		console.error(
			`serenity: ${target ? `${target} is not` : "you are not"} in a git repo; run it inside one or name one: serenity slack ${sub} <repo>`,
		);
		return 1;
	}
	const name = basename(repo);
	if (sub === "status") {
		console.log(
			slackIsOn(repo, file)
				? `Slack is on for ${name} (${repo}).`
				: turnOnHint(repo),
		);
		return 0;
	}
	const on = sub === "on";
	if (slackIsOn(repo, file) === on) {
		console.log(`Slack is already ${sub} for ${name}.`);
		return 0;
	}
	try {
		const applies = await setSlack(home, repo, on, file);
		console.log(`Slack is ${sub} for ${name}: ${applies}.`);
		return 0;
	} catch (e) {
		console.error(`serenity: ${(e as Error).message}`);
		return 1;
	}
}

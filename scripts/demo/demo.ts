#!/usr/bin/env bun
/**
 * Drives the README demo (see scripts/demo/README.md): a throwaway world with
 * a git repo, fake claude (agent.ts), fake gh and a fake Slack inbox, all in
 * a private tmux server, so a recording shows the real TUI but nothing real.
 *
 *   bun scripts/demo/demo.ts start   set up the world, start the map and the
 *                                    sessions, and wait until they are working
 *   bun scripts/demo/demo.ts play    run the timeline in scenario.ts
 *   bun scripts/demo/demo.ts attach  attach this terminal to the map
 *   bun scripts/demo/demo.ts stop    stop serenity and delete the world
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connectDaemon,
	type RepoState,
	type RpcPeer,
	type Session,
	tmuxSessionName,
} from "../../packages/core/src/index";
import { type DemoSlackItem, REPO, SESSIONS, TIMELINE } from "./scenario";

const ROOT = join(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "packages/cli/src/main.ts");
const SOCKET = "serenity-readme-demo";
// Real path: serenity knows a repo by its git top level, and macOS tmpdir is a symlink.
const WORLD = join(realpathSync(tmpdir()), "serenity-readme-demo");
const REPO_DIR = join(WORLD, "work", REPO);
const HOME = join(WORLD, "home");
const GH_DIR = join(WORLD, "gh");
const SLACK = join(WORLD, "slack.json");
const MAP = `${tmuxSessionName(REPO_DIR)}:map`;
/** The map's size until a client attaches; vhs then resizes it to its own. */
const COLS = 190;
const ROWS = 50;

const env: Record<string, string> = {
	SERENITY_HOME: HOME,
	SERENITY_TMUX_SOCKET: SOCKET,
	SERENITY_CLAUDE_BIN: join(import.meta.dir, "agent.ts"),
	SERENITY_GH_BIN: join(ROOT, "e2e/fake-gh.ts"),
	SERENITY_FAKE_GH_DIR: GH_DIR,
	SERENITY_FAKE_SLACK: SLACK,
	SERENITY_SELF: JSON.stringify([process.execPath, MAIN]),
	SERENITY_WORKER_DEBOUNCE_MS: "100",
	SERENITY_SLACK_POLL_MS: "1000",
	SERENITY_REVIEW_POLL_MS: "60000",
	XDG_CONFIG_HOME: join(WORLD, "config"),
	CLAUDE_CONFIG_DIR: join(WORLD, "claude"),
};

function tmux(...args: string[]): string {
	const result = spawnSync("tmux", ["-L", SOCKET, ...args], {
		encoding: "utf8",
	});
	if (result.status !== 0)
		throw new Error(`tmux ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

/** Types a line into a session's agent pane, as demo commands for agent.ts. */
function typeInAgent(name: string, text: string): void {
	const target = `${tmuxSessionName(REPO_DIR)}:${name}`;
	tmux("send-keys", "-t", target, "-l", text);
	tmux("send-keys", "-t", target, "Enter");
}

async function until<T>(
	check: () => T | undefined | false,
	what: string,
	timeoutMs = 30_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = check();
		if (value) return value;
		await Bun.sleep(100);
	}
	throw new Error(`demo: timed out waiting for ${what}`);
}

/** A daemon connection that keeps the latest repo state. */
async function connect(): Promise<{ peer: RpcPeer; state: () => RepoState }> {
	let peer: RpcPeer | null = null;
	for (let i = 0; i < 300 && !peer; i++) {
		peer = await connectDaemon(HOME);
		if (!peer) await Bun.sleep(100);
	}
	if (!peer) throw new Error("demo: could not connect to the daemon");
	let latest = await peer.request("state.subscribe", { repo: REPO_DIR });
	peer.onNotification((method, params) => {
		if (method === "state.changed" && (params as RepoState).repo === REPO_DIR)
			latest = params as RepoState;
	});
	return { peer, state: () => latest };
}

function stop(): void {
	if (existsSync(HOME))
		spawnSync(process.execPath, [MAIN, "stop"], {
			env: { ...process.env, ...env },
		});
	spawnSync("tmux", ["-L", SOCKET, "kill-server"]);
	rmSync(WORLD, { recursive: true, force: true });
	// Worktrees live beside the repo.
	for (const s of SESSIONS)
		rmSync(join(WORLD, "work", `${REPO}-${s.name}`), {
			recursive: true,
			force: true,
		});
}

function makeWorld(): void {
	mkdirSync(REPO_DIR, { recursive: true });
	mkdirSync(HOME, { recursive: true });
	mkdirSync(GH_DIR, { recursive: true });
	writeFileSync(join(HOME, ".doctor-ok"), "demo\n");
	mkdirSync(join(WORLD, "config", "serenity"), { recursive: true });
	writeFileSync(
		join(WORLD, "config", "serenity", "config.json"),
		JSON.stringify({ slack: { repos: [REPO_DIR] } }),
	);
	writeFileSync(SLACK, "[]");
	const git = (...args: string[]) =>
		spawnSync(
			"git",
			[
				"-C",
				REPO_DIR,
				"-c",
				"user.name=demo",
				"-c",
				"user.email=demo@example.com",
				...args,
			],
			{ encoding: "utf8" },
		);
	git("init", "-q", "-b", "main");
	writeFileSync(join(REPO_DIR, "README.md"), "# acme-shop\n");
	git("add", ".");
	git("commit", "-q", "-m", "init");
	for (const s of SESSIONS) {
		if (!s.pr) continue;
		writeFileSync(
			join(GH_DIR, `${s.name}.json`),
			JSON.stringify({
				number: s.pr.number,
				url: `https://github.com/acme/${REPO}/pull/${s.pr.number}`,
				title: s.brief,
				state: "OPEN",
				isDraft: false,
				statusCheckRollup: [
					s.pr.checks === "SUCCESS"
						? {
								__typename: "CheckRun",
								status: "COMPLETED",
								conclusion: "SUCCESS",
							}
						: { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" },
				],
				reviewDecision: "REVIEW_REQUIRED",
				reviewRequests: [{ login: "a-reviewer" }],
				latestReviews: [],
				author: { login: "me" },
			}),
		);
	}
}

async function start(): Promise<void> {
	stop();
	makeWorld();
	const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
	tmux(
		"new-session",
		"-d",
		"-s",
		tmuxSessionName(REPO_DIR),
		"-n",
		"map",
		"-x",
		String(COLS),
		"-y",
		String(ROWS),
		"-c",
		REPO_DIR,
		...envArgs,
		"--",
		process.execPath,
		MAIN,
		"tui",
	);
	tmux("set-option", "-g", "status", "off");
	const { peer, state } = await connect();
	const byName = (name: string) =>
		state().sessions.find((s: Session) => s.name === name);

	for (const s of SESSIONS)
		await peer.request("session.create", {
			repo: REPO_DIR,
			name: s.name,
			cwd: REPO_DIR,
			mode: "worktree",
			prompt: s.brief,
		});
	await until(
		() => SESSIONS.every((s) => byName(s.name)?.status === "working"),
		"every session to start working",
	);
	// Each pauses once so the master files it under its topic, then carries on.
	for (const s of SESSIONS) typeInAgent(s.name, `pause ${s.progress}`);
	await until(
		() => SESSIONS.every((s) => byName(s.name)?.topic === s.topic),
		"every session's topic",
	);
	for (const s of SESSIONS) if (!s.done) typeInAgent(s.name, "resume");
	await until(
		() =>
			SESSIONS.every(
				(s) => byName(s.name)?.status === (s.done ? "done" : "working"),
			),
		"the sessions to be back at work",
	);
	peer.close();
	console.log("demo: ready");
}

async function play(): Promise<void> {
	const began = Date.now();
	const slack: object[] = [];
	for (const event of TIMELINE) {
		const wait = began + event.at - Date.now();
		if (wait > 0) await Bun.sleep(wait);
		if (event.kind === "permission")
			typeInAgent(event.session, `permission ${event.command}`);
		else if (event.kind === "ask")
			typeInAgent(event.session, `ask ${event.question}`);
		else {
			slack.push(slackMessage(event.item, slack.length));
			writeFileSync(SLACK, JSON.stringify(slack));
		}
	}
}

/** A Slack message as the inbox worker returns it. */
function slackMessage(item: DemoSlackItem, index: number) {
	const ts = `${Math.floor(Date.now() / 1000)}.00010${index}`;
	return {
		channelId: `C0DEMO${index}`,
		channel: item.channel,
		author: item.author,
		text: item.text,
		reason: item.reason,
		action: item.action,
		ts,
		threadTs: ts,
		permalink: null,
	};
}

const command = process.argv[2];
if (command === "start") await start();
else if (command === "play") await play();
else if (command === "attach")
	spawnSync("tmux", ["-L", SOCKET, "attach", "-t", MAP], { stdio: "inherit" });
else if (command === "stop") stop();
else {
	console.error("usage: bun scripts/demo/demo.ts start|play|attach|stop");
	process.exit(2);
}
process.exit(0);

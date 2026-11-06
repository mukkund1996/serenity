#!/usr/bin/env bun
/**
 * Drives the demos (see scripts/demo/README.md): a throwaway world with
 * a git repo, fake claude (agent.ts), fake gh and a fake Slack inbox, all in
 * a private tmux server, so a recording shows the real TUI but nothing real.
 *
 *   bun scripts/demo/demo.ts start   set up the world, start the map and the
 *                                    sessions, and wait until they are working
 *   bun scripts/demo/demo.ts play [name]
 *                                    run a timeline in scenario.ts (default
 *                                    readme; the docs GIFs have their own)
 *   bun scripts/demo/demo.ts attach  attach this terminal to the map
 *   bun scripts/demo/demo.ts stop    stop serenity and delete the world
 *   bun scripts/demo/demo.ts fresh   a first boot instead (onboarding.tape):
 *                                    an empty repo and serenity home, with
 *                                    `serenity` and a logged-out fake `gh` on
 *                                    PATH; `source` the env.sh it writes
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	realpathSync,
	rmSync,
	utimesSync,
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
	transcriptPathFor,
} from "../../packages/core/src/index";
import {
	type DemoSlackItem,
	LATER_SESSIONS,
	REPO,
	SESSIONS,
	TIMELINES,
} from "./scenario";

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
	// The busy-world GIFs start with sessions; a first boot's tutorial would join them.
	SERENITY_NO_ONBOARDING: "1",
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
	for (const s of [...SESSIONS, ...LATER_SESSIONS])
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

/** Past Claude Code sessions in the fresh repo: prompt, branch, hours ago. */
const PAST_SESSIONS: Array<[string, string, number]> = [
	["Add a cart badge with the item count", "feat/cart-badge", 3],
	["Why does checkout double-charge on retry?", "fix/checkout-retry", 26],
	["Write tests for the coupon parser", "main", 52],
	["Tidy the product page copy", "copy/product-page", 98],
];

/** A transcript as Claude Code writes it, last active `hours` ago. */
function pastSession(
	id: string,
	prompt: string,
	branch: string,
	hours: number,
): void {
	const path = transcriptPathFor(env.CLAUDE_CONFIG_DIR as string, REPO_DIR, id);
	const at = new Date(Date.now() - hours * 3_600_000);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({
			type: "user",
			isSidechain: false,
			message: { role: "user", content: prompt },
			timestamp: at.toISOString(),
			entrypoint: "cli",
			cwd: REPO_DIR,
			sessionId: id,
			gitBranch: branch,
		})}\n`,
	);
	utimesSync(path, at, at);
}

/**
 * A first boot (onboarding.tape): an empty repo, an empty serenity home and
 * config, no doctor marker, and onboarding on, plus a few past Claude Code
 * sessions in the repo for the import step (ADR 0066). Writes env.sh, which
 * puts `serenity` (this checkout) and the fake `gh`, logged out, on PATH.
 */
function fresh(): void {
	stop();
	const bin = join(WORLD, "bin");
	for (const dir of [REPO_DIR, HOME, GH_DIR, bin, join(WORLD, "config")])
		mkdirSync(dir, { recursive: true });
	writeFileSync(join(GH_DIR, "logged-out"), "");
	writeFileSync(SLACK, "[]");
	const script = (name: string, body: string) =>
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	script("serenity", `exec "${process.execPath}" "${MAIN}" "$@"`);
	script(
		"gh",
		`exec "${process.execPath}" "${join(ROOT, "e2e/fake-gh.ts")}" "$@"`,
	);
	const git = (...args: string[]) =>
		spawnSync("git", ["-C", REPO_DIR, ...args], { encoding: "utf8" });
	git("init", "-q", "-b", "main");
	writeFileSync(join(REPO_DIR, "README.md"), "# acme-shop\n");
	git("add", ".");
	git(
		"-c",
		"user.name=demo",
		"-c",
		"user.email=demo@example.com",
		"commit",
		"-q",
		"-m",
		"init",
	);
	for (const [i, [prompt, branch, hours]] of PAST_SESSIONS.entries())
		pastSession(
			`0d3a7c55-0000-4000-8000-00000000000${i + 1}`,
			prompt,
			branch,
			hours,
		);
	const { SERENITY_NO_ONBOARDING: _, ...firstBoot } = env;
	const lines = Object.entries({
		...firstBoot,
		SERENITY_GH_BIN: join(bin, "gh"),
		SERENITY_FAKE_GH_LOGIN: "sam-demo",
		SERENITY_FAKE_GH_LOGIN_MS: "1500",
		SERENITY_FAKE_SLACK_LOGIN: "Sam (Acme)",
		SERENITY_FAKE_MCP_LOGIN_MS: "2000",
		PATH: `${bin}:${process.env.PATH}`,
	}).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`);
	writeFileSync(
		join(WORLD, "env.sh"),
		// Unset TMUX: recorded from inside tmux, `serenity` would think it ran in the map's.
		`${lines.join("\n")}\nunset TMUX TMUX_PANE\nexport PS1='\\[\\e[2m\\]~/work/${REPO}\\[\\e[0m\\] $ '\ncd ${JSON.stringify(REPO_DIR)}\n`,
	);
	console.log(join(WORLD, "env.sh"));
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

async function play(name = "readme"): Promise<void> {
	const timeline = TIMELINES[name];
	if (!timeline) throw new Error(`demo: no timeline named ${name}`);
	const began = Date.now();
	const slack: object[] = [];
	for (const event of timeline) {
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
else if (command === "play") await play(process.argv[3]);
else if (command === "attach")
	spawnSync("tmux", ["-L", SOCKET, "attach", "-t", MAP], { stdio: "inherit" });
else if (command === "stop") stop();
else if (command === "fresh") fresh();
else {
	console.error(
		"usage: bun scripts/demo/demo.ts start|play [name]|attach|stop|fresh",
	);
	process.exit(2);
}
process.exit(0);

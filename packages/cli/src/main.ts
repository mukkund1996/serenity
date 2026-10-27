#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	BUILD_ID,
	configPath,
	connectDaemon,
	doctorMarkerPath,
	ensureDaemon,
	isHookKind,
	loadConfig,
	SLACK_SERVER,
	selfCommand,
	serenityHome,
	socketPath,
	tmuxSessionName,
	VERSION,
} from "@serenity/core";
import { printChecks, runChecks } from "./doctor";
import {
	runUserStatusLine,
	type StatusLineInput,
	userStatusLineCommand,
} from "./statusline";

const USAGE = `serenity ${VERSION} · a mind map of your Claude Code sessions

usage:
  serenity            open the map for the git repo you are in
  serenity doctor     check tmux, claude, git and gh
  serenity slack login  sign in to Slack for the master (once)
  serenity stop       stop the background daemon
  serenity restart    restart it (sessions keep running)
  serenity version

internal:
  serenity daemon | tui | hook <Event> | statusline | exited <code> | detach <pane> [master] | mcp <repo>`;

const home = serenityHome();

/** Records that the first-run doctor passed, so `serenity` skips it next time. */
function markDoctorOk(): void {
	mkdirSync(home, { recursive: true });
	writeFileSync(doctorMarkerPath(home), `${new Date().toISOString()}\n`);
}

function fail(message: string): never {
	console.error(`serenity: ${message}`);
	process.exit(1);
}

function repoRoot(): string {
	const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		encoding: "utf8",
	});
	if (result.status !== 0) fail("run it inside a git repository");
	return result.stdout.trim();
}

function tmux(args: string[], stdio: "inherit" | "pipe" = "pipe") {
	const socket = process.env.SERENITY_TMUX_SOCKET;
	return spawnSync("tmux", socket ? ["-L", socket, ...args] : args, {
		stdio,
		encoding: "utf8",
	});
}

/** `serenity`: doctor on first run, daemon up, then the map inside the repo's tmux session (ADR 0012). */
async function launch(): Promise<void> {
	const repo = repoRoot();
	if (!existsSync(doctorMarkerPath(home))) {
		if (!printChecks(runChecks()))
			fail("fix the items above, then run serenity again");
		markDoctorOk();
	}
	(await ensureDaemon(home)).close();

	if (process.env.TMUX) return runTuiHere(repo);

	const session = tmuxSessionName(repo);
	const tui = [...selfCommand(), "tui"];
	if (tmux(["has-session", "-t", `=${session}`]).status !== 0) {
		tmux(["new-session", "-d", "-s", session, "-n", "map", "-c", repo, ...tui]);
	} else if (
		!tmux(["list-windows", "-t", `=${session}`, "-F", "#{window_name}"])
			.stdout.split("\n")
			.includes("map")
	) {
		tmux(["new-window", "-t", `=${session}:`, "-n", "map", "-c", repo, ...tui]);
	}
	tmux(["select-window", "-t", `=${session}:map`]);
	// The map is the whole screen; parked agent windows stay out of sight.
	tmux(["set-option", "-t", `=${session}:`, "status", "off"]);
	const attached = tmux(
		["-u", "attach-session", "-t", `=${session}`],
		"inherit",
	);
	process.exit(attached.status ?? 0);
}

async function runTuiHere(repo: string): Promise<void> {
	const { runTui } = await import("@serenity/tui");
	await runTui({ home, repo });
	process.exit(0);
}

/** `serenity hook <Event>`: forward Claude Code's hook JSON to the daemon. Never blocks or fails Claude. */
async function hook(kind: string | undefined): Promise<void> {
	const sessionId = process.env.SERENITY_SESSION_ID;
	const raw = await Bun.stdin.text().catch(() => "");
	if (!sessionId || !kind || !isHookKind(kind)) process.exit(0);
	let payload = {};
	try {
		payload = JSON.parse(raw);
	} catch {}
	// Start the daemon if it is down (a restart, a new build), so no event is lost.
	const peer = await ensureDaemon(home, 3000).catch(() => null);
	await peer
		?.request("hook.event", { sessionId, kind, payload }, { timeoutMs: 1000 })
		.catch(() => {});
	peer?.close();
	process.exit(0);
}

/**
 * `serenity statusline`: Claude Code's status line in spawned sessions.
 * Reports plan usage to a running daemon and prints the user's own status
 * line, if they have one (ADR 0020). Never starts the daemon: it runs often.
 */
async function statusline(): Promise<void> {
	const raw = await Bun.stdin.text().catch(() => "");
	let input: StatusLineInput = {};
	try {
		input = JSON.parse(raw);
	} catch {}
	const report = async () => {
		if (!input.rate_limits) return;
		const peer = await connectDaemon(home).catch(() => null);
		await peer
			?.request(
				"usage.report",
				{ rateLimits: input.rate_limits },
				{ timeoutMs: 1000 },
			)
			.catch(() => {});
		peer?.close();
	};
	const command = userStatusLineCommand(input);
	const [, line] = await Promise.all([
		report(),
		command ? runUserStatusLine(command, raw, input.cwd) : "",
	]);
	process.stdout.write(line);
	process.exit(0);
}

/** `serenity exited <code>`: run by the agent's wrapper shell when claude exits. */
async function exited(code: string | undefined): Promise<void> {
	const sessionId = process.env.SERENITY_SESSION_ID;
	if (!sessionId) process.exit(0);
	const parsed = Number(code);
	const peer = await ensureDaemon(home, 3000).catch(() => null);
	await peer
		?.request(
			"session.exited",
			{ sessionId, code: Number.isInteger(parsed) ? parsed : null },
			{ timeoutMs: 1000 },
		)
		.catch(() => {});
	peer?.close();
	process.exit(0);
}

async function detach(
	pane: string | undefined,
	then: string | undefined,
): Promise<void> {
	const peer = await connectDaemon(home);
	if (!peer) fail("daemon is not running");
	await peer.request(
		"session.detach",
		{ pane, master: then === "master" },
		{ timeoutMs: 5000 },
	);
	peer.close();
}

async function runDaemon(): Promise<void> {
	const { Daemon, createSqliteStorage } = await import("@serenity/daemon");
	const { dbPath } = await import("@serenity/core");
	mkdirSync(home, { recursive: true });
	const daemon = new Daemon({
		home,
		storage: createSqliteStorage(dbPath(home)),
	});
	await daemon.start();
	const stop = () => void daemon.stop();
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	await daemon.done;
	process.exit(0);
}

async function stopDaemon(): Promise<void> {
	const peer = await connectDaemon(home);
	if (!peer) return console.log("daemon is not running");
	await peer
		.request("daemon.shutdown", {}, { timeoutMs: 2000 })
		.catch(() => {});
	peer.close();
	for (let i = 0; i < 40 && existsSync(socketPath(home)); i++)
		await Bun.sleep(50);
	console.log("daemon stopped");
}

/**
 * `serenity slack login` (ADR 0023): the master reads Slack through its MCP
 * server, isolated from the user's own MCP config, so it signs in apart. The
 * server is registered only for serenity's workers folder, then `claude mcp
 * login` runs the OAuth flow; later `claude -p` calls reuse the token.
 */
function slackLogin(): void {
	const claude = process.env.SERENITY_CLAUDE_BIN ?? "claude";
	const config = loadConfig();
	const cwd = join(home, "workers");
	mkdirSync(cwd, { recursive: true });
	const run = (args: string[], stdio: "inherit" | "pipe" = "inherit") =>
		spawnSync(claude, args, { cwd, stdio, encoding: "utf8" });
	// Replaced, so a changed `slack.mcp` in the config takes effect.
	run(["mcp", "remove", "-s", "local", SLACK_SERVER], "pipe");
	const added = run([
		"mcp",
		"add-json",
		"-s",
		"local",
		SLACK_SERVER,
		JSON.stringify(config.slack.mcp),
	]);
	if (added.status !== 0) fail("could not register Slack's MCP server");
	if (config.slack.mcp.type === "stdio")
		console.log("A stdio server signs in through its own settings.");
	else if (run(["mcp", "login", SLACK_SERVER]).status !== 0)
		fail("Slack login did not finish");
	console.log(
		config.slack.repos.length
			? `Slack is on for: ${config.slack.repos.join(", ")}`
			: `Slack is off for every repo. List repos under slack.repos in ${configPath()}, then run serenity restart.`,
	);
}

const [command, arg] = process.argv.slice(2);
switch (command) {
	case undefined:
		await launch();
		break;
	case "tui":
		(await ensureDaemon(home)).close();
		await runTuiHere(repoRoot());
		break;
	case "hook":
		await hook(arg);
		break;
	case "mcp": {
		if (!arg) fail("usage: serenity mcp <repo>");
		const { runMcpProxy } = await import("@serenity/daemon");
		await runMcpProxy(home, arg);
		break;
	}
	case "statusline":
		await statusline();
		break;
	case "exited":
		await exited(arg);
		break;
	case "detach":
		await detach(arg, process.argv[4]);
		break;
	case "daemon":
		await runDaemon();
		break;
	case "doctor": {
		const ok = printChecks(runChecks());
		if (ok) markDoctorOk();
		process.exit(ok ? 0 : 1);
		break;
	}
	case "slack":
		if (arg !== "login") fail("usage: serenity slack login");
		slackLogin();
		break;
	case "stop":
		await stopDaemon();
		break;
	case "restart": {
		await stopDaemon();
		(await ensureDaemon(home)).close();
		console.log(`daemon running ${BUILD_ID}`);
		break;
	}
	case "version":
	case "--version":
	case "-v":
		console.log(BUILD_ID);
		break;
	case "help":
	case "--help":
	case "-h":
		console.log(USAGE);
		break;
	default:
		console.error(USAGE);
		process.exit(2);
}

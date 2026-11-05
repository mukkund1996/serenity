/**
 * ADR 0062 end to end: the first map on a fresh home shows the learn-serenity
 * tutorial, its agent gets the prompt and the plugin, and once archived it
 * stays gone across a restart.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectDaemon, type RepoState } from "../packages/core/src";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "packages/cli/src/main.ts");
const FAKE = join(ROOT, "e2e/fake-claude.ts");
const FAKE_GH = join(ROOT, "e2e/fake-gh.ts");
const SOCKET = `serenity-onboarding-e2e-${process.pid}`;
const MAP = "serenity-demo:map";
const TIMEOUT = 30_000;

let dir = "";
let repo = "";
let home = "";
let env: Record<string, string> = {};

function tmux(...args: string[]): string {
	const result = spawnSync("tmux", ["-L", SOCKET, ...args], {
		encoding: "utf8",
	});
	if (result.status !== 0)
		throw new Error(`tmux ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

const screen = () => tmux("capture-pane", "-p", "-t", MAP);
const serenity = (...args: string[]) =>
	spawnSync(process.execPath, [MAIN, ...args], {
		env: { ...process.env, ...env },
		encoding: "utf8",
	});

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function until<T>(
	check: () => T | Promise<T>,
	what: string,
	timeoutMs = 15_000,
): Promise<NonNullable<T>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await check();
		if (value) return value as NonNullable<T>;
		await Bun.sleep(100);
	}
	throw new Error(`timed out waiting for ${what}; screen was:\n${screen()}`);
}

/** The repo's state, as a map that opens now gets it. */
async function subscribe(): Promise<RepoState> {
	const peer = await until(() => connectDaemon(home), "the daemon");
	try {
		return await peer.request("state.subscribe", { repo });
	} finally {
		peer.close();
	}
}

async function sessions() {
	const peer = await until(() => connectDaemon(home), "the daemon");
	try {
		// A second subscribe returns the state without starting anything.
		return (await peer.request("state.subscribe", { repo })).sessions;
	} finally {
		peer.close();
	}
}

beforeAll(() => {
	// Real paths: the map names its repo as git does (/private/var on macOS).
	dir = realpathSync(mkdtempSync(join(tmpdir(), "sronboard-")));
	repo = join(dir, "repos", "demo");
	home = join(dir, "home");
	mkdirSync(repo, { recursive: true });
	mkdirSync(home);
	mkdirSync(join(dir, "gh"));
	writeFileSync(join(home, ".doctor-ok"), "e2e\n");
	const git = (...args: string[]) =>
		spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git(
		"-c",
		"user.name=e2e",
		"-c",
		"user.email=e2e@example.com",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"init",
	);
	env = {
		SERENITY_HOME: home,
		SERENITY_TMUX_SOCKET: SOCKET,
		SERENITY_CLAUDE_BIN: FAKE,
		SERENITY_SELF: JSON.stringify([process.execPath, MAIN]),
		SERENITY_STARTUP_GRACE_MS: "300",
		SERENITY_WORKER_DEBOUNCE_MS: "100",
		SERENITY_GH_BIN: FAKE_GH,
		SERENITY_FAKE_GH_DIR: join(dir, "gh"),
		XDG_CONFIG_HOME: join(dir, "config"),
		CLAUDE_CONFIG_DIR: join(dir, "claude"),
	};
	const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
	tmux(
		"new-session",
		"-d",
		"-s",
		"serenity-demo",
		"-n",
		"map",
		"-x",
		"200",
		"-y",
		"50",
		"-c",
		repo,
		...envArgs,
		"--",
		process.execPath,
		MAIN,
		"tui",
	);
});

afterAll(() => {
	serenity("stop");
	spawnSync("tmux", ["-L", SOCKET, "kill-server"]);
	if (process.env.SERENITY_E2E_KEEP) console.log(`kept ${dir}`);
	else if (dir) rmSync(dir, { recursive: true, force: true });
});

test(
	"the first map shows learn-serenity, whose agent starts the tutorial with its skill",
	async () => {
		await until(() => screen().includes("learn-serenity"), "the tutorial node");
		const [tutorial, ...rest] = await sessions();
		expect(rest).toEqual([]);
		// In the repo itself: no worktree, no new branch.
		expect(tutorial).toMatchObject({
			name: "learn-serenity",
			cwd: repo,
			worktree: null,
			ownsBranch: false,
		});
		// The fake claude fired UserPromptSubmit with the first prompt.
		await until(async () => {
			const [s] = await sessions();
			return s?.lastPrompt === "teach me how to use serenity";
		}, "the tutorial prompt to reach the agent");
		const start = tmux(
			"display-message",
			"-p",
			"-t",
			tutorial?.tmuxPane as string,
			"#{pane_start_command}",
		);
		expect(start).toContain("--plugin-dir");
		expect(start).toContain(join(home, "tutorial-plugin"));
	},
	TIMEOUT,
);

test(
	"archived, it stays gone after a restart",
	async () => {
		const [tutorial] = await sessions();
		const peer = await until(() => connectDaemon(home), "the daemon");
		try {
			await peer.request("session.kill", { id: tutorial?.id as string });
		} finally {
			peer.close();
		}
		// Close the map first, so it cannot start a daemon of its own meanwhile.
		tmux("kill-window", "-t", MAP);
		const supervisor = Number(readFileSync(join(home, "daemon.lock"), "utf8"));
		expect(serenity("stop").status).toBe(0);
		await until(() => !alive(supervisor), "the old supervisor to exit");
		expect(serenity("restart").status).toBe(0);
		const state = await subscribe();
		expect(state.sessions.map((s) => [s.name, s.status])).toEqual([
			["learn-serenity", "archived"],
		]);
		await Bun.sleep(500);
		expect((await sessions()).filter((s) => s.status !== "archived")).toEqual(
			[],
		);
	},
	TIMEOUT,
);

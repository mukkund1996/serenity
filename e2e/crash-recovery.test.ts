/**
 * ADR 0045 end to end: the supervisor restarts a killed daemon, which comes
 * back with its state and matches it to tmux; a crashing daemon files one
 * deduped issue through the fake gh, then the supervisor gives up.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectDaemon, type RpcPeer } from "../packages/core/src";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "packages/cli/src/main.ts");
const FAKE = join(ROOT, "e2e/fake-claude.ts");
const FAKE_GH = join(ROOT, "e2e/fake-gh.ts");
const SOCKET = `serenity-crash-e2e-${process.pid}`;
const STEP_TIMEOUT = 30_000;

let dir = "";
let repo = "";

function tmux(...args: string[]): string {
	const result = spawnSync("tmux", ["-L", SOCKET, ...args], {
		encoding: "utf8",
	});
	if (result.status !== 0)
		throw new Error(`tmux ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
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
	throw new Error(`timed out waiting for ${what}`);
}

function envFor(home: string, extra: Record<string, string> = {}) {
	return {
		...process.env,
		SERENITY_HOME: home,
		SERENITY_TMUX_SOCKET: SOCKET,
		SERENITY_CLAUDE_BIN: FAKE,
		SERENITY_SELF: JSON.stringify([process.execPath, MAIN]),
		SERENITY_STARTUP_GRACE_MS: "300",
		SERENITY_WORKER_DEBOUNCE_MS: "100",
		SERENITY_GH_BIN: FAKE_GH,
		SERENITY_FAKE_GH_DIR: join(dir, "gh"),
		SERENITY_SUPERVISOR_BACKOFF_MS: "100",
		XDG_CONFIG_HOME: join(dir, "config"),
		CLAUDE_CONFIG_DIR: join(dir, "claude"),
		...extra,
	};
}

/** The daemon's pid, once one of this build answers. */
async function daemonPid(home: string): Promise<number | null> {
	const peer = await connectDaemon(home);
	if (!peer) return null;
	const hello = await peer.request("hello", { clientVersion: "" });
	peer.close();
	return hello.pid;
}

async function withDaemon<T>(
	home: string,
	fn: (peer: RpcPeer) => Promise<T>,
): Promise<T> {
	const peer = await until(() => connectDaemon(home), "the daemon");
	try {
		return await fn(peer);
	} finally {
		peer.close();
	}
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "srcrash-"));
	repo = join(dir, "repos", "demo");
	mkdirSync(repo, { recursive: true });
	mkdirSync(join(dir, "gh"));
	mkdirSync(join(dir, "config", "serenity"), { recursive: true });
	writeFileSync(
		join(dir, "config", "serenity", "config.json"),
		JSON.stringify({ crashReports: { enabled: true, repo: "acme/serenity" } }),
	);
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
	// The repo's tmux session, where spawned sessions park.
	tmux("new-session", "-d", "-s", "serenity-demo", "-n", "map", "-c", repo);
});

afterAll(() => {
	// tmux first: a session's exit hook would start the daemon again.
	spawnSync("tmux", ["-L", SOCKET, "kill-server"]);
	for (const home of ["home", "crashy"])
		spawnSync(process.execPath, [MAIN, "stop"], {
			env: envFor(join(dir, home)),
		});
	if (process.env.SERENITY_E2E_KEEP) console.log(`kept ${dir}`);
	else if (dir) rmSync(dir, { recursive: true, force: true });
});

test(
	"a killed daemon comes back with its sessions and usage, matched to tmux",
	async () => {
		const home = join(dir, "home");
		const env = envFor(home);
		expect(spawnSync(process.execPath, [MAIN, "restart"], { env }).status).toBe(
			0,
		);
		const supervisor = Number(readFileSync(join(home, "daemon.lock"), "utf8"));
		const first = await until(() => daemonPid(home), "the first worker");

		const session = await withDaemon(home, async (peer) => {
			const created = await peer.request(
				"session.create",
				{ repo, name: "api", cwd: repo, mode: "worktree" },
				{ timeoutMs: 10_000 },
			);
			await peer.request("usage.report", {
				rateLimits: { five_hour: { used_percentage: 42, resets_at: 2e9 } },
			});
			return created;
		});
		expect(session.tmuxPane).toBeTruthy();

		process.kill(first, "SIGKILL");
		const second = await until(async () => {
			const pid = await daemonPid(home);
			return pid && pid !== first ? pid : null;
		}, "a restarted worker");
		expect(second).not.toBe(first);
		// The same supervisor restarted it.
		expect(Number(readFileSync(join(home, "daemon.lock"), "utf8"))).toBe(
			supervisor,
		);

		const state = await withDaemon(home, (peer) =>
			peer.request("state.subscribe", { repo }),
		);
		const back = state.sessions.find((s) => s.id === session.id);
		expect(back?.tmuxPane).toBe(session.tmuxPane);
		expect(back?.status).not.toBe("dead");
		expect(state.usage?.session?.usedPercent).toBe(42);

		// A pane closed while no daemon ran: the restart marks its session ended.
		process.kill(second, "SIGKILL");
		tmux("kill-pane", "-t", session.tmuxPane as string);
		await until(async () => {
			const pid = await daemonPid(home);
			return pid && pid !== second ? pid : null;
		}, "a second restart");
		const after = await withDaemon(home, (peer) =>
			peer.request("state.subscribe", { repo }),
		);
		expect(after.sessions.find((s) => s.id === session.id)?.status).toBe(
			"dead",
		);
		expect(readFileSync(join(home, "daemon.log"), "utf8")).toContain(
			"api ended while the daemon was down",
		);
		// kill -9 from outside is no bug of serenity's: nothing was filed.
		expect(existsSync(join(dir, "gh", "issues.json"))).toBe(false);
	},
	STEP_TIMEOUT,
);

/** Runs a supervisor whose worker always crashes, until it gives up. */
async function crashLoop(home: string): Promise<number> {
	mkdirSync(home, { recursive: true });
	const log = openSync(join(home, "daemon.log"), "a");
	const proc = Bun.spawn([process.execPath, MAIN, "daemon"], {
		stdio: ["ignore", log, log],
		env: envFor(home, {
			SERENITY_DEBUG_CRASH: `boom in ${home}`,
			SERENITY_SUPERVISOR_CRASH_LIMIT: "3",
		}),
	});
	return proc.exited;
}

const ghJson = (name: string) => {
	const file = join(dir, "gh", name);
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
};

test(
	"a crash loop files one deduped issue, then the supervisor gives up",
	async () => {
		const home = join(dir, "crashy");
		expect(await crashLoop(home)).toBe(1);
		const issues = ghJson("issues.json");
		expect(issues).toHaveLength(1);
		const [issue] = issues;
		expect(issue.repo).toBe("acme/serenity");
		expect(issue.title).toMatch(
			/^Crash: Error: boom in <path> \(sig:[0-9a-f]{12}\)$/,
		);
		expect(issue.body).toContain("packages/cli/src/main.ts");
		expect(issue.body).not.toContain(dir);
		expect(ghJson("comments.json")).toHaveLength(0);
		expect(readFileSync(join(home, "daemon.log"), "utf8")).toContain(
			"giving up",
		);

		// Another machine (no local rate-limit state) comments on the open issue.
		rmSync(join(home, "crash-reports", "state.json"));
		expect(await crashLoop(home)).toBe(1);
		expect(ghJson("issues.json")).toHaveLength(1);
		expect(ghJson("comments.json")).toEqual([
			{ issue: 1, body: expect.stringContaining("Happened again") },
		]);
	},
	STEP_TIMEOUT,
);

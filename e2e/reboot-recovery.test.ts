/**
 * ADR 0070 end to end: the tmux server goes away (a reboot, a shutdown,
 * `tmux kill-server`) and the sessions that were live come back in new
 * panes with `claude --resume`, in their worktrees, once their map opens.
 * Ended, archived and unrestorable ones stay ended.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connectDaemon,
	type RepoState,
	type RpcPeer,
	type Session,
} from "../packages/core/src";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "packages/cli/src/main.ts");
const FAKE = join(ROOT, "e2e/fake-claude.ts");
const FAKE_GH = join(ROOT, "e2e/fake-gh.ts");
const SOCKET = `serenity-reboot-e2e-${process.pid}`;
const STEP_TIMEOUT = 60_000;

let dir = "";
let repo = "";

function tmux(...args: string[]): string {
	// The fake claude keeps a transcript only with CLAUDE_CONFIG_DIR, which
	// panes get from the server's environment.
	const result = spawnSync("tmux", ["-L", SOCKET, ...args], {
		encoding: "utf8",
		env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, "claude") },
	});
	if (result.status !== 0)
		throw new Error(`tmux ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

async function until<T>(
	check: () => T | Promise<T>,
	what: string,
	timeoutMs = 20_000,
): Promise<NonNullable<T>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await check();
		if (value) return value as NonNullable<T>;
		await Bun.sleep(100);
	}
	throw new Error(`timed out waiting for ${what}`);
}

function envFor(home: string) {
	return {
		...process.env,
		SERENITY_HOME: home,
		SERENITY_TMUX_SOCKET: SOCKET,
		SERENITY_CLAUDE_BIN: FAKE,
		SERENITY_SELF: JSON.stringify([process.execPath, MAIN]),
		SERENITY_NO_ONBOARDING: "1",
		SERENITY_STARTUP_GRACE_MS: "300",
		SERENITY_WORKER_DEBOUNCE_MS: "100",
		SERENITY_GH_BIN: FAKE_GH,
		SERENITY_FAKE_GH_DIR: join(dir, "gh"),
		SERENITY_TMUX_CHECK_MS: "200",
		SERENITY_RESTORE_STAGGER_MS: "100",
		XDG_CONFIG_HOME: join(dir, "config"),
		CLAUDE_CONFIG_DIR: join(dir, "claude"),
	};
}

const cli = (home: string, ...args: string[]) =>
	spawnSync(process.execPath, [MAIN, ...args], {
		env: envFor(home),
		encoding: "utf8",
	});

async function connect(home: string): Promise<RpcPeer> {
	return until(() => connectDaemon(home), "the daemon");
}

/** Every pane on the test server: id, marker, cwd and start command. */
function panes(): {
	pane: string;
	session: string;
	cwd: string;
	cmd: string;
}[] {
	let out = "";
	try {
		out = tmux(
			"list-panes",
			"-a",
			"-F",
			"#{pane_id}\t#{@serenity_session}\t#{pane_current_path}\t#{pane_start_command}",
		);
	} catch {
		return [];
	}
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [pane = "", session = "", cwd = "", ...cmd] = line.split("\t");
			return { pane, session, cwd, cmd: cmd.join("\t") };
		});
}

/** A state, kept current from the daemon's broadcasts. */
function follow(peer: RpcPeer, first: RepoState) {
	let state = first;
	peer.onNotification((method, params) => {
		if (method === "state.changed") state = params as RepoState;
	});
	return {
		get: () => state,
		session: (id: string) => state.sessions.find((s) => s.id === id),
	};
}

/** Starts a worktree session and has it answer one prompt, so it has a conversation to resume. */
async function started(peer: RpcPeer, name: string): Promise<Session> {
	const s = await peer.request(
		"session.create",
		{ repo, name, cwd: repo, mode: "worktree" },
		{ timeoutMs: 15_000 },
	);
	// "?" makes the fake ask back, so the session waits, never "done".
	await until(async () => {
		try {
			await peer.request("session.reply", { id: s.id, text: `hello ${name}?` });
			return true;
		} catch {
			return false;
		}
	}, `${name} to take a prompt`);
	return s;
}

/** Stops the daemon and waits for its supervisor to exit too. */
async function stopped(home: string): Promise<void> {
	const lock = join(home, "daemon.lock");
	const pid = existsSync(lock) ? Number(readFileSync(lock, "utf8")) : 0;
	expect(cli(home, "stop").status).toBe(0);
	await until(() => {
		if (!pid) return true;
		try {
			process.kill(pid, 0);
			return false;
		} catch {
			return true;
		}
	}, "the supervisor to exit");
}

const realCwd = (s: Session) => realpathSync(s.cwd);

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "srreboot-"));
	repo = join(dir, "repos", "demo");
	mkdirSync(repo, { recursive: true });
	mkdirSync(join(dir, "gh"));
	mkdirSync(join(dir, "config", "serenity"), { recursive: true });
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
	repo = realpathSync(repo);
	tmux("new-session", "-d", "-s", "serenity-demo", "-n", "map", "-c", repo);
});

afterAll(() => {
	spawnSync("tmux", ["-L", SOCKET, "kill-server"]);
	for (const home of ["reboot", "live", "upgrade"])
		cli(join(dir, home), "stop");
	if (process.env.SERENITY_E2E_KEEP) console.log(`kept ${dir}`);
	else if (dir) rmSync(dir, { recursive: true, force: true });
});

test(
	"after a reboot, live sessions come back resumed in their worktrees; others stay ended",
	async () => {
		const home = join(dir, "reboot");
		expect(cli(home, "restart").status).toBe(0);
		let peer = await connect(home);
		const api = await started(peer, "api");
		const web = await started(peer, "web");
		const docs = await started(peer, "docs");
		const old = await peer.request(
			"session.create",
			{ repo, name: "old", cwd: repo, mode: "worktree" },
			{ timeoutMs: 15_000 },
		);
		await peer.request("session.kill", { id: old.id });
		const before = await until(async () => {
			const state = await peer.request("state.subscribe", { repo });
			const live = [api, web, docs].map((s) =>
				state.sessions.find((x) => x.id === s.id),
			);
			return live.every((s) => s?.claudeSessionId && s.status === "waiting")
				? live
				: null;
		}, "the sessions to wait on their question");
		peer.close();

		// The machine goes down: the daemon and the tmux server with it.
		await stopped(home);
		tmux("kill-server");
		// A worktree deleted while the machine was off cannot come back.
		rmSync(docs.cwd, { recursive: true, force: true });

		// The first `serenity` after the restart: the daemon, then the map.
		expect(cli(home, "restart").status).toBe(0);
		peer = await connect(home);
		const state = follow(peer, await peer.request("state.subscribe", { repo }));
		for (const s of [api, web]) {
			const back = await until(() => {
				const now = state.session(s.id);
				return now?.status !== "dead" && now?.tmuxPane ? now : null;
			}, `${s.name} to be restored`);
			const claudeId = before.find((b) => b?.id === s.id)?.claudeSessionId;
			const pane = await until(
				() =>
					panes().find(
						(p) => p.pane === back.tmuxPane && p.cmd.includes("--resume"),
					),
				`${s.name}'s pane`,
			);
			expect(pane.cmd).toContain(`--resume ${claudeId}`);
			expect(realpathSync(pane.cwd)).toBe(realCwd(s));
			expect(pane.session).toBe(s.id);
			await until(
				() =>
					tmux("capture-pane", "-p", "-t", pane.pane).includes(
						`resumed ${claudeId}`,
					),
				`${s.name}'s claude to resume`,
			);
			expect(back.exitNote).toBe(
				"restored after a restart; it was waiting on you",
			);
			expect(back.topic).toBe(
				before.find((b) => b?.id === s.id)?.topic ?? null,
			);
			expect(back.interrupted).toBeNull();
		}
		const report = await until(() => {
			const r = state.get().restore;
			return r && r.pending === 0 ? r : null;
		}, "the restore to finish");
		expect(report.restored.sort()).toEqual(["api", "web"]);
		expect(report.failed).toEqual([
			{ name: "docs", reason: `its folder ${docs.cwd} is gone` },
		]);
		expect(state.session(docs.id)?.status).toBe("dead");
		expect(state.session(docs.id)?.exitNote).toContain(
			"not restored after a restart",
		);
		expect(state.session(old.id)?.status).toBe("archived");

		// Opening the map again (or a second map) never doubles a window.
		await peer.request("state.subscribe", { repo });
		await Bun.sleep(500);
		for (const s of [api, web])
			expect(panes().filter((p) => p.session === s.id)).toHaveLength(1);
		expect(panes().some((p) => p.session === old.id)).toBe(false);
		peer.close();
		expect(cli(home, "stop").status).toBe(0);
	},
	STEP_TIMEOUT,
);

test(
	"tmux killed while the daemon runs: an open map gets its sessions back",
	async () => {
		const home = join(dir, "live");
		tmux("new-session", "-d", "-s", "keep", "-c", repo);
		expect(cli(home, "restart").status).toBe(0);
		const peer = await connect(home);
		const state = follow(peer, await peer.request("state.subscribe", { repo }));
		const app = await started(peer, "app");
		const first = await until(() => {
			const s = state.session(app.id);
			return s?.claudeSessionId && s.status === "waiting" ? s : null;
		}, "app to wait on its question");

		tmux("kill-server");
		const back = await until(() => {
			const s = state.session(app.id);
			return s?.status !== "dead" &&
				s?.tmuxPane &&
				s.tmuxPane !== first.tmuxPane &&
				!s.interrupted
				? s
				: null;
		}, "app to be restored");
		const pane = await until(
			() => panes().find((p) => p.session === app.id),
			"app's new pane",
		);
		expect(pane.pane).toBe(back.tmuxPane as string);
		expect(pane.cmd).toContain(`--resume ${first.claudeSessionId}`);
		expect(realpathSync(pane.cwd)).toBe(realCwd(app));
		peer.close();
	},
	STEP_TIMEOUT,
);

test(
	"sessions an older build ended after the reboot come back once a new build starts",
	async () => {
		const home = join(dir, "upgrade");
		expect(cli(home, "restart").status).toBe(0);
		let peer = await connect(home);
		const lib = await started(peer, "lib");
		await until(async () => {
			const state = await peer.request("state.subscribe", { repo });
			const s = state.sessions.find((x) => x.id === lib.id);
			return s?.claudeSessionId && s.status === "waiting";
		}, "lib to wait on its question");
		peer.close();
		await stopped(home);
		tmux("kill-server");
		// What a build before ADR 0070 left: the session ended with no reason,
		// and no tmux server on record.
		const db = new Database(join(home, "serenity.db"));
		const row = db
			.query<{ data: string }, [string]>(
				"SELECT data FROM sessions WHERE id = ?",
			)
			.get(lib.id);
		const data = JSON.parse(row?.data ?? "{}");
		Object.assign(data, {
			status: "dead",
			tmuxPane: null,
			exitNote: null,
			interrupted: null,
			updatedAt: Date.now(),
		});
		db.run("UPDATE sessions SET data = ? WHERE id = ?", [
			JSON.stringify(data),
			lib.id,
		]);
		db.run("DELETE FROM recovery WHERE key = 'tmuxServer'");
		db.close();
		// The user's `serenity` starts a tmux server before the daemon.
		tmux("new-session", "-d", "-s", "serenity-demo", "-n", "map", "-c", repo);

		expect(cli(home, "restart").status).toBe(0);
		peer = await connect(home);
		const state = follow(peer, await peer.request("state.subscribe", { repo }));
		const back = await until(() => {
			const s = state.session(lib.id);
			return s?.status !== "dead" && s?.tmuxPane ? s : null;
		}, "lib to be restored");
		const pane = await until(
			() =>
				panes().find((p) => p.pane === back.tmuxPane && p.session === lib.id),
			"lib's pane",
		);
		expect(pane.cmd).toContain(`--resume ${data.claudeSessionId}`);
		expect(realpathSync(pane.cwd)).toBe(realCwd(lib));
		peer.close();
		await stopped(home);
	},
	STEP_TIMEOUT,
);

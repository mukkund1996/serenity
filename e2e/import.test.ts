/**
 * ADR 0064 end to end: past Claude Code sessions found in CLAUDE_CONFIG_DIR
 * are suggested on an empty map, listed by `serenity import`, imported with
 * I, resumed with `claude --resume` in their own folder, refused while still
 * open in a terminal, and imported by the master's import_sessions.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connectDaemon,
	type Session,
	transcriptPathFor,
} from "../packages/core/src";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "packages/cli/src/main.ts");
const FAKE = join(ROOT, "e2e/fake-claude.ts");
const FAKE_GH = join(ROOT, "e2e/fake-gh.ts");
const SOCKET = `serenity-import-e2e-${process.pid}`;
const MAP = "serenity-demo:map";
const TIMEOUT = 30_000;

const README = "11111111-aaaa-4bbb-8ccc-000000000001";
const LOGIN = "22222222-aaaa-4bbb-8ccc-000000000002";
const OTHER = "33333333-aaaa-4bbb-8ccc-000000000003";
const GONE = "44444444-aaaa-4bbb-8ccc-000000000004";
const HEADLESS = "55555555-aaaa-4bbb-8ccc-000000000005";
const OPEN = "66666666-aaaa-4bbb-8ccc-000000000006";
const API = "77777777-aaaa-4bbb-8ccc-000000000007";

let dir = "";
let repo = "";
let worktree = "";
let other = "";
let home = "";
let claude = "";
let env: Record<string, string> = {};
/** Stands for a claude still open in a plain terminal. */
let terminal: ChildProcess | null = null;

function tmux(...args: string[]): string {
	const result = spawnSync("tmux", ["-L", SOCKET, ...args], {
		encoding: "utf8",
	});
	if (result.status !== 0)
		throw new Error(`tmux ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

const screen = () => tmux("capture-pane", "-p", "-t", MAP);
const keys = (...k: string[]) => tmux("send-keys", "-t", MAP, ...k);
const serenity = (cwd: string, ...args: string[]) =>
	spawnSync(process.execPath, [MAIN, ...args], {
		cwd,
		env: { ...process.env, ...env },
		encoding: "utf8",
	});

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

async function rpc<T>(
	run: (
		peer: NonNullable<Awaited<ReturnType<typeof connectDaemon>>>,
	) => Promise<T>,
): Promise<T> {
	const peer = await until(() => connectDaemon(home), "the daemon");
	try {
		return await run(peer);
	} finally {
		peer.close();
	}
}

const sessions = (of = repo): Promise<Session[]> =>
	rpc(
		async (peer) =>
			(await peer.request("state.subscribe", { repo: of })).sessions,
	);

const byClaudeId = async (id: string, of = repo) =>
	(await sessions(of)).find((s) => s.claudeSessionId === id);

/** Writes a transcript as Claude Code would. */
function transcript(
	id: string,
	cwd: string,
	{
		title,
		prompt = `work on ${id.slice(0, 8)}`,
		branch = "main",
		entrypoint = "cli",
	}: {
		title?: string;
		prompt?: string;
		branch?: string;
		entrypoint?: string;
	} = {},
): void {
	const path = transcriptPathFor(claude, cwd, id);
	mkdirSync(join(path, ".."), { recursive: true });
	const lines: object[] = [
		{
			type: "user",
			isSidechain: false,
			message: { role: "user", content: prompt },
			timestamp: new Date(Date.now() - 3_600_000).toISOString(),
			entrypoint,
			cwd,
			sessionId: id,
			gitBranch: branch,
		},
	];
	if (title) lines.push({ type: "custom-title", customTitle: title });
	writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

/** Every file under Claude's folder with its size, to prove nothing changed. */
function claudeFiles(): string[] {
	return readdirSync(join(claude, "projects"), { recursive: true })
		.map(String)
		.sort()
		.map((f) => {
			const p = join(claude, "projects", f);
			return `${f}:${statSync(p).isFile() ? statSync(p).size : "dir"}`;
		});
}

beforeAll(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "srimport-")));
	repo = join(dir, "repos", "demo");
	worktree = join(dir, "repos", "demo-login");
	other = join(dir, "repos", "other");
	home = join(dir, "home");
	claude = join(dir, "claude");
	for (const d of [
		repo,
		other,
		home,
		join(dir, "gh"),
		join(claude, "sessions"),
	])
		mkdirSync(d, { recursive: true });
	writeFileSync(join(home, ".doctor-ok"), "e2e\n");
	for (const r of [repo, other]) {
		const git = (...args: string[]) =>
			spawnSync("git", ["-C", r, ...args], { encoding: "utf8" });
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
	}
	spawnSync("git", [
		"-C",
		repo,
		"worktree",
		"add",
		"-q",
		"-b",
		"fix/login",
		worktree,
	]);
	mkdirSync(join(repo, "packages", "api"), { recursive: true });

	transcript(README, repo, { title: "Tidy the README" });
	transcript(LOGIN, worktree, {
		title: "Fix login redirect",
		branch: "fix/login",
	});
	transcript(OTHER, other, { title: "Other repo work" });
	transcript(GONE, join(dir, "repos", "deleted-worktree"));
	transcript(HEADLESS, repo, { entrypoint: "sdk-cli" });
	transcript(OPEN, repo, { title: "Still open elsewhere" });
	terminal = spawn("sleep", ["120"], { stdio: "ignore" });
	writeFileSync(
		join(claude, "sessions", `${terminal.pid}.json`),
		JSON.stringify({
			kind: "interactive",
			pid: terminal.pid,
			sessionId: OPEN,
			cwd: repo,
			status: "idle",
		}),
	);

	env = {
		SERENITY_HOME: home,
		SERENITY_TMUX_SOCKET: SOCKET,
		SERENITY_CLAUDE_BIN: FAKE,
		SERENITY_SELF: JSON.stringify([process.execPath, MAIN]),
		SERENITY_STARTUP_GRACE_MS: "300",
		SERENITY_WORKER_DEBOUNCE_MS: "100",
		SERENITY_NO_ONBOARDING: "1",
		SERENITY_GH_BIN: FAKE_GH,
		SERENITY_FAKE_GH_DIR: join(dir, "gh"),
		XDG_CONFIG_HOME: join(dir, "config"),
		CLAUDE_CONFIG_DIR: claude,
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
	terminal?.kill();
	serenity(repo, "stop");
	spawnSync("tmux", ["-L", SOCKET, "kill-server"]);
	if (process.env.SERENITY_E2E_KEEP) console.log(`kept ${dir}`);
	else if (dir) rmSync(dir, { recursive: true, force: true });
});

test(
	"an empty map points at the sessions the user already has",
	async () => {
		await until(
			() => screen().includes("past Claude sessions here · I imports them"),
			"the import hint",
		);
		// README, the worktree's login fix and the one open in a terminal.
		expect(screen()).toContain("3 past Claude sessions here");
	},
	TIMEOUT,
);

test(
	"serenity import --list shows this repo's, grouped, with what cannot resume left out",
	() => {
		const out = serenity(worktree, "import", "--list");
		expect(out.status).toBe(0);
		expect(out.stdout).toContain(`demo  (${repo})`);
		expect(out.stdout).toContain("tidy-the-readme");
		expect(out.stdout).toContain("fix-login-redirect  ·  fix/login");
		expect(out.stdout).toContain(
			`still open in a terminal (pid ${terminal?.pid})`,
		);
		expect(out.stdout).toContain("1 more left out: their folder is gone");
		expect(out.stdout).not.toContain("other-repo-work");
		expect(out.stdout).not.toContain(HEADLESS.slice(0, 8));
	},
	TIMEOUT,
);

test(
	"I lists them, Enter imports them ended, without touching Claude's folder",
	async () => {
		const before = claudeFiles();
		keys("I");
		await until(
			() => screen().includes("From history, last 14 days"),
			"the picker",
		);
		expect(screen()).toContain("fix-login-redirect");
		expect(screen()).toContain("open in a terminal");
		keys("Enter");
		await until(() => screen().includes("imported 3 sessions"), "the import");
		const imported = (await sessions()).filter((s) => s.origin === "imported");
		expect(imported.map((s) => s.claudeSessionId).sort()).toEqual(
			[README, LOGIN, OPEN].sort(),
		);
		expect(imported.every((s) => s.status === "dead" && !s.tmuxPane)).toBe(
			true,
		);
		await until(
			() => screen().includes("Imported. Enter resumes it."),
			"a parked card",
		);
		expect(claudeFiles()).toEqual(before);
	},
	TIMEOUT,
);

test(
	"Enter resumes one with claude --resume in its own worktree",
	async () => {
		const login = await byClaudeId(LOGIN);
		const mapPane = tmux(
			"display-message",
			"-p",
			"-t",
			MAP,
			"#{pane_id}",
		).trim();
		await rpc((peer) =>
			peer.request("session.attach", {
				id: login?.id as string,
				clientPane: mapPane,
			}),
		);
		const resumed = await until(async () => {
			const s = await byClaudeId(LOGIN);
			return s?.origin === "spawned" && s.tmuxPane ? s : null;
		}, "the resume");
		expect(resumed).toMatchObject({ cwd: worktree, tracking: "hooks" });
		const start = tmux(
			"display-message",
			"-p",
			"-t",
			resumed.tmuxPane as string,
			"#{pane_start_command}",
		);
		expect(start).toContain(`--resume ${LOGIN}`);
		await until(
			() =>
				tmux("capture-pane", "-p", "-t", resumed.tmuxPane as string).includes(
					`resumed ${LOGIN}`,
				),
			"the fake claude to resume it",
		);
		await rpc((peer) => peer.request("session.detach", { id: resumed.id }));
	},
	TIMEOUT,
);

test(
	"one still open in a terminal resumes only once it is quit there",
	async () => {
		const open = await byClaudeId(OPEN);
		const mapPane = tmux(
			"display-message",
			"-p",
			"-t",
			MAP,
			"#{pane_id}",
		).trim();
		const attach = () =>
			rpc((peer) =>
				peer.request("session.attach", {
					id: open?.id as string,
					clientPane: mapPane,
				}),
			);
		await expect(attach()).rejects.toThrow(
			`still open in another terminal (pid ${terminal?.pid})`,
		);
		expect((await byClaudeId(OPEN))?.status).toBe("dead");
		terminal?.kill();
		await until(
			() => terminal?.exitCode !== null || terminal?.signalCode,
			"sleep to exit",
		);
		await attach();
		await until(async () => (await byClaudeId(OPEN))?.tmuxPane, "the resume");
		await rpc((peer) =>
			peer.request("session.detach", { id: open?.id as string }),
		);
	},
	TIMEOUT,
);

test(
	"serenity import --all-repos --yes brings in other repos' onto their maps, once",
	async () => {
		const out = serenity(dir, "import", "--all-repos", "--yes");
		expect(out.status).toBe(0);
		expect(out.stdout).toContain("Imported 1 session: other-repo-work.");
		expect((await byClaudeId(OTHER, other))?.origin).toBe("imported");
		const again = serenity(dir, "import", "--all-repos", "--yes");
		expect(again.stdout).toContain(
			"No Claude Code sessions in any repo to import",
		);
	},
	TIMEOUT,
);

test(
	"the master's import_sessions imports by folder and date",
	async () => {
		transcript(API, join(repo, "packages", "api"), {
			title: "API rate limits",
		});
		const today = new Date();
		const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
		const result = await rpc((peer) =>
			peer.request("master.tool", {
				repo,
				name: "import_sessions",
				args: { dir: "packages/api", since: date, until: date },
			}),
		);
		expect(result.isError).toBeFalsy();
		expect(result.text).toContain("Imported 1");
		expect(result.text).toContain("api-rate-limits");
		expect(await byClaudeId(API)).toMatchObject({
			origin: "imported",
			cwd: join(repo, "packages", "api"),
		});
	},
	TIMEOUT,
);

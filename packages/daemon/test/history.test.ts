import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	createMemoryStorage,
	groupByRepo,
	type Storage,
	transcriptPathFor,
} from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import { ClaudeHistory } from "../src/history";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "shistory-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
	spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

function gitRepo(path: string): string {
	mkdirSync(path, { recursive: true });
	git(path, "init", "-q", "-b", "main");
	git(
		path,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@example.com",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"init",
	);
	return path;
}

const repo = gitRepo(join(dir, "demo"));
const other = gitRepo(join(dir, "other"));
const worktree = join(dir, "demo-login");
git(repo, "worktree", "add", "-q", "-b", "fix/login", worktree);
const plain = join(dir, "not-git");
mkdirSync(plain);

const DAY = 86_400_000;
const NOW = Date.now();

let config: string;
let storage: Storage;
let history: ClaudeHistory;

/** Writes a transcript where Claude Code would, last written `daysAgo`. */
function transcript(
	id: string,
	cwd: string,
	{
		prompt = `work on ${id}`,
		title,
		branch = "main",
		daysAgo = 1,
		entrypoint = "cli",
	}: {
		prompt?: string;
		title?: string;
		branch?: string;
		daysAgo?: number;
		entrypoint?: string;
	} = {},
): string {
	const path = transcriptPathFor(config, cwd, id);
	mkdirSync(dirname(path), { recursive: true });
	const at = new Date(NOW - daysAgo * DAY - 3_600_000).toISOString();
	const lines: object[] = [
		{ type: "mode", sessionId: id },
		{
			type: "user",
			isSidechain: false,
			message: { role: "user", content: prompt },
			timestamp: at,
			entrypoint,
			cwd,
			sessionId: id,
			gitBranch: branch,
		},
	];
	if (title) lines.push({ type: "custom-title", customTitle: title });
	writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	const mtime = (NOW - daysAgo * DAY) / 1000;
	utimesSync(path, mtime, mtime);
	return path;
}

function running(id: string, cwd: string, pid: number, tmux?: string): void {
	writeFileSync(
		join(config, "sessions", `${pid}.json`),
		JSON.stringify({
			kind: "interactive",
			pid,
			sessionId: id,
			cwd,
			status: "idle",
			...(tmux ? { tmux } : {}),
		}),
	);
}

beforeEach(() => {
	config = mkdtempSync(join(dir, "claude-"));
	mkdirSync(join(config, "sessions"));
	storage = createMemoryStorage();
	history = new ClaudeHistory(
		{ storage, now: () => NOW, log: () => {} },
		config,
	);
});

describe("discover", () => {
	test("groups sessions by repo, worktrees under their main checkout", async () => {
		transcript("s-main", repo, { title: "Tidy the README" });
		transcript("s-wt", worktree, { branch: "fix/login", daysAgo: 0 });
		transcript("s-other", other, { daysAgo: 2 });
		const { sessions } = await history.discover();
		expect(
			groupByRepo(sessions).map((g) => [
				g.repo,
				g.sessions.map((s) => s.claudeSessionId),
			]),
		).toEqual([
			[repo, ["s-wt", "s-main"]],
			[other, ["s-other"]],
		]);
		const wt = sessions.find((s) => s.claudeSessionId === "s-wt");
		expect(wt).toMatchObject({
			cwd: worktree,
			repo,
			branch: "fix/login",
			firstPrompt: "work on s-wt",
			name: "work-on-s-wt",
			runningPid: null,
		});
		expect(sessions.find((s) => s.claudeSessionId === "s-main")?.name).toBe(
			"tidy-the-readme",
		);
	});

	test("filters by repo (any path in it), by dates and by folder", async () => {
		transcript("old", repo, { daysAgo: 20 });
		transcript("new", repo, { daysAgo: 1 });
		transcript("wt", worktree, { daysAgo: 1 });
		transcript("elsewhere", other, { daysAgo: 1 });
		const ids = async (f: Parameters<ClaudeHistory["discover"]>[0]) =>
			(await history.discover(f)).sessions.map((s) => s.claudeSessionId).sort();
		expect(await ids({ repo: worktree })).toEqual(["new", "old", "wt"]);
		expect(await ids({ repo, since: NOW - 14 * DAY })).toEqual(["new", "wt"]);
		expect(await ids({ until: NOW - 10 * DAY })).toEqual(["old"]);
		expect(await ids({ dir: worktree })).toEqual(["wt"]);
		expect(await ids({ repo: plain })).toEqual([]);
	});

	test("skips headless runs, folders outside git, and counts deleted folders", async () => {
		transcript("headless", repo, { entrypoint: "sdk-cli" });
		transcript("plain", plain);
		transcript("gone", join(dir, "deleted-worktree"));
		transcript("ok", repo);
		const { sessions, gone } = await history.discover();
		expect(sessions.map((s) => s.claudeSessionId)).toEqual(["ok"]);
		expect(gone).toBe(1);
	});

	test("skips what serenity already has, archived too", async () => {
		transcript("tracked", repo);
		transcript("archived", repo);
		transcript("free", repo);
		storage.sessions.put(
			makeSession({ id: "a", repo, claudeSessionId: "tracked" }),
		);
		storage.sessions.put(
			makeSession({
				id: "b",
				repo,
				claudeSessionId: "archived",
				status: "archived",
			}),
		);
		const { sessions } = await history.discover();
		expect(sessions.map((s) => s.claudeSessionId)).toEqual(["free"]);
	});

	test("one still running in tmux is left to I's adopt; one in a plain terminal is marked", async () => {
		transcript("in-tmux", repo);
		transcript("in-terminal", repo);
		// This test process stands for a live claude.
		running("in-tmux", repo, process.pid, "work:@3.%7");
		const { sessions: a } = await history.discover();
		expect(a.map((s) => s.claudeSessionId)).toEqual(["in-terminal"]);
		rmSync(join(config, "sessions", `${process.pid}.json`));
		running("in-terminal", repo, process.pid);
		const { sessions: b } = await history.discover();
		expect(b.find((s) => s.claudeSessionId === "in-terminal")?.runningPid).toBe(
			process.pid,
		);
		expect(history.running().get("in-terminal")?.inTmux).toBe(false);
	});

	test("a dead pid is not running", async () => {
		transcript("s", repo);
		running("s", repo, 999_999);
		expect(history.running().size).toBe(0);
		expect((await history.discover()).sessions[0]?.runningPid).toBeNull();
	});

	test("rereads a transcript that grew, and only reads the ends of a large one", async () => {
		const path = transcript("grows", repo);
		expect((await history.discover()).sessions[0]?.title).toBeNull();
		// 2 MB of turns in the middle, then a title at the end.
		const turn = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "text", text: "x".repeat(1000) }] },
		});
		appendFileSync(path, `${`${turn}\n`.repeat(2000)}`);
		appendFileSync(
			path,
			`${JSON.stringify({ type: "ai-title", aiTitle: "Grew up" })}\n`,
		);
		expect(statSync(path).size).toBeGreaterThan(2_000_000);
		const [s] = (await history.discover()).sessions;
		expect(s?.title).toBe("Grew up");
		expect(s?.firstPrompt).toBe("work on grows");
	});

	test("never writes to Claude's folder", async () => {
		transcript("a", repo);
		const before = readdirSync(config, { recursive: true }).sort();
		await history.discover();
		await history.import(["a"]);
		expect(readdirSync(config, { recursive: true }).sort()).toEqual(before);
	});
});

describe("import", () => {
	test("puts sessions on their repo's map, ended until Enter resumes them", async () => {
		transcript("s-wt", worktree, { branch: "fix/login", title: "Login fix" });
		transcript("s-other", other);
		const imported = (
			await history.import(["s-wt", "s-other", "missing"])
		).sort((a, b) => a.repo.localeCompare(b.repo));
		expect(imported.map((s) => [s.repo, s.name])).toEqual([
			[repo, "login-fix"],
			[other, "work-on-s-other"],
		]);
		expect(storage.sessions.get(imported[0]?.id as string)).toMatchObject({
			cwd: worktree,
			worktree: null,
			ownsBranch: false,
			branch: "fix/login",
			origin: "imported",
			tracking: "hooks",
			status: "dead",
			tmuxPane: null,
			claudeSessionId: "s-wt",
			lastPrompt: "work on s-wt",
		});
		// A second import finds nothing new.
		expect(await history.import(["s-wt"])).toEqual([]);
	});

	test("names never clash with the map's sessions", async () => {
		transcript("a", repo, { title: "Docs" });
		transcript("b", repo, { title: "Docs" });
		storage.sessions.put(makeSession({ id: "x", repo, name: "docs" }));
		const names = (await history.import(["a", "b"])).map((s) => s.name);
		expect(names.sort()).toEqual(["docs-2", "docs-3"]);
	});

	test("the asking map keeps its own key for its repo", async () => {
		transcript("a", repo);
		const [s] = await history.import(["a"], worktree);
		expect(s?.repo).toBe(worktree);
	});
});

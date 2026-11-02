import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createMemoryStorage,
	type PrInfo,
	type Session,
	type Storage,
	type Suggestion,
} from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import { Gh, type PrLookup } from "../src/gh";
import { PrWatcher, resolveHeads } from "../src/prs";

class FakeGh extends Gh {
	lookup: PrLookup = { pr: null, error: null };
	/** Answered first, one per call, before `lookup`. */
	queue: PrLookup[] = [];
	/** Answers for one ref (head or PR number), before `queue`; others get "no PR" while any is set. */
	byRef = new Map<string, PrLookup>();
	refs: string[] = [];
	calls = 0;
	override async viewPr(_cwd: string, ref: string): Promise<PrLookup> {
		this.calls++;
		this.refs.push(ref);
		if (this.byRef.size)
			return this.byRef.get(ref) ?? { pr: null, error: null };
		return this.queue.shift() ?? this.lookup;
	}
	override async currentUser(): Promise<string | null> {
		return "me";
	}
}

const dir = mkdtempSync(join(tmpdir(), "sprs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function pr(overrides: Partial<PrInfo> = {}): PrInfo {
	return {
		number: 42,
		url: "https://github.com/o/r/pull/42",
		title: "t",
		state: "OPEN",
		isDraft: false,
		checks: "passing",
		reviewDecision: null,
		reviewRequests: [],
		reviewed: false,
		author: "me",
		headRefOid: "abc",
		baseRefName: "main",
		files: ["src/api/x.ts"],
		...overrides,
	};
}

let storage: Storage;
let gh: FakeGh;
let proposed: Array<Pick<Suggestion, "kind" | "label" | "text">>;
let watcher: PrWatcher;
let worktree: string;
/** What resolveHeads would give; null means just the session's branch. */
let heads: string[] | null;
let watching: boolean;

function put(overrides: Partial<Session>): Session {
	const s = makeSession({ worktree, cwd: worktree, ...overrides });
	storage.sessions.put(s);
	return s;
}

beforeEach(() => {
	worktree = mkdtempSync(join(dir, "wt-"));
	storage = createMemoryStorage();
	gh = new FakeGh();
	proposed = [];
	heads = null;
	watching = true;
	watcher = new PrWatcher({
		storage,
		gh,
		reviewers: ["carol"],
		change: (session, patch) => {
			const next = { ...session, ...patch };
			storage.sessions.put(next);
			return next;
		},
		broadcast: () => {},
		propose: (_s, kind, label, text) => proposed.push({ kind, label, text }),
		log: () => {},
		debounceMs: 0,
		retryBackoff: { baseMs: 2, maxMs: 4 },
		rateLimitBackoff: { baseMs: 20, maxMs: 40 },
		heads: async (s) => heads ?? [s.branch as string],
		watching: () => watching,
		pollMs: 0,
	});
});

describe("PrWatcher", () => {
	test("stores the PR, or the reason it could not be read", async () => {
		put({ id: "s1" });
		gh.lookup = { pr: null, error: "gh not logged in" };
		await watcher.refresh("s1");
		expect(storage.sessions.get("s1")).toMatchObject({
			pr: null,
			prError: "gh not logged in",
		});
		gh.lookup = { pr: pr({ checks: "running" }), error: null };
		await watcher.refresh("s1");
		expect(storage.sessions.get("s1")).toMatchObject({
			pr: { number: 42 },
			prError: null,
		});
	});

	test("a lasting gh error keeps a PR already known, with the reason", async () => {
		put({ id: "s1" });
		gh.lookup = { pr: pr(), error: null };
		await watcher.refresh("s1");
		for (const error of [
			"gh not logged in",
			"unreadable gh output",
			"GraphQL: Something went wrong",
		]) {
			gh.lookup = { pr: null, error };
			await watcher.refresh("s1");
			expect(storage.sessions.get("s1")).toMatchObject({
				pr: { number: 42 },
				prError: error,
			});
		}
	});

	test("a head that no longer has a PR keeps the known one, read by its number", async () => {
		put({ id: "s1", branch: "feature" });
		gh.byRef.set("feature", { pr: pr({ number: 7 }), error: null });
		await watcher.refresh("s1");
		// The branch was deleted after the merge, or the agent moved on.
		gh.byRef.clear();
		gh.byRef.set("7", { pr: pr({ number: 7, state: "MERGED" }), error: null });
		await watcher.refresh("s1");
		expect(gh.refs).toEqual(["feature", "feature", "7"]);
		expect(storage.sessions.get("s1")?.pr).toMatchObject({
			number: 7,
			state: "MERGED",
		});
	});

	test("the PR is found under the head the work was pushed as", async () => {
		// Session X, whose agent pushed docs/X: the first head with a PR wins.
		put({ id: "s1", name: "x", branch: "x" });
		heads = ["docs/x", "x", "owner:docs/x"];
		gh.byRef.set("x", { pr: null, error: null });
		gh.byRef.set("owner:docs/x", { pr: pr({ number: 9 }), error: null });
		await watcher.refresh("s1");
		expect(gh.refs).toEqual(["docs/x", "x", "owner:docs/x"]);
		expect(storage.sessions.get("s1")?.pr?.number).toBe(9);
	});

	test("an error on one head stops the search and keeps the PR", async () => {
		put({ id: "s1" });
		gh.lookup = { pr: pr(), error: null };
		await watcher.refresh("s1");
		heads = ["a", "b"];
		gh.byRef.set("a", { pr: null, error: "gh not logged in" });
		gh.byRef.set("b", { pr: pr({ number: 99 }), error: null });
		await watcher.refresh("s1");
		expect(gh.refs.slice(1)).toEqual(["a"]);
		expect(storage.sessions.get("s1")?.pr?.number).toBe(42);
	});

	test("a rate limit keeps the PR, reads again later, and pauses polling", async () => {
		put({ id: "s1" });
		gh.lookup = { pr: pr(), error: null };
		await watcher.refresh("s1");
		gh.queue = [{ pr: null, error: "gh rate limited" }];
		gh.lookup = { pr: pr({ checks: "failing" }), error: null };
		await watcher.refresh("s1");
		expect(storage.sessions.get("s1")).toMatchObject({
			pr: { number: 42, checks: "passing" },
			prError: "gh rate limited",
		});
		watcher.poll("/repos/demo");
		watcher.poll("/repos/demo");
		watcher.poll("/repos/demo");
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(gh.calls).toBe(2);
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(gh.calls).toBe(3);
		expect(storage.sessions.get("s1")).toMatchObject({
			pr: { checks: "failing" },
			prError: null,
		});
	});

	test("a merged PR makes an idle session finished", async () => {
		put({ id: "s1", status: "idle" });
		gh.lookup = { pr: pr({ state: "MERGED" }), error: null };
		await watcher.refresh("s1");
		expect(storage.sessions.get("s1")?.status).toBe("done");
	});

	test("an imported session shows the merge but is not finished by it", async () => {
		put({ id: "s1", status: "idle", origin: "adopted", tracking: "observed" });
		gh.lookup = { pr: pr({ state: "MERGED" }), error: null };
		await watcher.refresh("s1");
		expect(storage.sessions.get("s1")).toMatchObject({
			status: "idle",
			pr: { state: "MERGED" },
		});
	});

	test("a pinned session shows the merge but is not finished by it", async () => {
		put({ id: "s1", status: "idle", pinned: true });
		gh.lookup = { pr: pr({ state: "MERGED" }), error: null };
		await watcher.refresh("s1");
		expect(storage.sessions.get("s1")).toMatchObject({
			status: "idle",
			pr: { state: "MERGED" },
		});
	});

	test("a busy session keeps its status", async () => {
		put({ id: "s1", status: "working" });
		gh.lookup = { pr: pr({ state: "MERGED" }), error: null };
		await watcher.refresh("s1");
		expect(storage.sessions.get("s1")?.status).toBe("working");
	});

	test("a ready PR gets a reviewer from CODEOWNERS, once", async () => {
		mkdirSync(join(worktree, ".github"));
		writeFileSync(
			join(worktree, ".github", "CODEOWNERS"),
			"* @me\nsrc/api/ @dave\n",
		);
		put({ id: "s1", status: "idle" });
		gh.lookup = { pr: pr(), error: null };
		await watcher.refresh("s1");
		expect(proposed).toEqual([
			{ kind: "review", label: "Request review from @dave", text: "dave" },
		]);
		await watcher.refresh("s1");
		expect(proposed).toHaveLength(1);
	});

	test("without CODEOWNERS the config list is used, never the author or me", async () => {
		put({ id: "s1", status: "done" });
		gh.lookup = { pr: pr({ author: "carol" }), error: null };
		await watcher.refresh("s1");
		expect(proposed).toEqual([]);
		gh.lookup = { pr: pr({ number: 43 }), error: null };
		await watcher.refresh("s1");
		expect(proposed).toEqual([
			{ kind: "review", label: "Request review from @carol", text: "carol" },
		]);
	});

	test("no reviewer while checks run, someone is asked, or another suggestion waits", async () => {
		put({ id: "s1", status: "idle" });
		gh.lookup = { pr: pr({ checks: "running" }), error: null };
		await watcher.refresh("s1");
		gh.lookup = {
			pr: pr({ number: 44, reviewRequests: ["dave"] }),
			error: null,
		};
		await watcher.refresh("s1");
		storage.suggestions.put({
			id: "g",
			repo: "/repos/demo",
			sessionId: "s1",
			kind: "reply",
			label: "x",
			text: "x",
			status: "pending",
			source: "worker",
			createdAt: 1,
			updatedAt: 1,
		});
		gh.lookup = { pr: pr({ number: 45 }), error: null };
		await watcher.refresh("s1");
		expect(proposed).toEqual([]);
	});

	test("sessions without a branch, or archived, are skipped", async () => {
		put({ id: "s1", branch: null });
		put({ id: "s2", status: "archived" });
		gh.lookup = { pr: pr(), error: null };
		await watcher.refresh("s1");
		await watcher.refresh("s2");
		expect(storage.sessions.get("s1")?.pr).toBeNull();
		expect(storage.sessions.get("s2")?.pr).toBeNull();
	});

	test("a gh blip keeps the PR on the card and reads it again soon", async () => {
		put({ id: "s1" });
		gh.lookup = { pr: pr(), error: null };
		await watcher.refresh("s1");
		gh.queue = [
			{ pr: null, error: "HTTP 502: Bad Gateway" },
			{ pr: null, error: "gh timed out" },
		];
		gh.lookup = { pr: pr({ checks: "failing" }), error: null };
		await watcher.refresh("s1");
		expect(storage.sessions.get("s1")).toMatchObject({
			pr: { number: 42, checks: "passing" },
			prError: "HTTP 502: Bad Gateway",
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(gh.calls).toBe(4);
		expect(storage.sessions.get("s1")).toMatchObject({
			pr: { checks: "failing" },
			prError: null,
		});
	});

	test("reading again after a blip stops after a few tries", async () => {
		put({ id: "s1" });
		gh.lookup = { pr: null, error: "HTTP 503: Service Unavailable" };
		await watcher.refresh("s1");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(gh.calls).toBe(6);
	});

	test("a lasting error is not read again", async () => {
		put({ id: "s1" });
		gh.lookup = { pr: null, error: "gh not logged in" };
		await watcher.refresh("s1");
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(gh.calls).toBe(1);
	});

	test("polling reads open PRs, running checks every tick, others every third", async () => {
		put({ id: "run", branch: "run" });
		put({ id: "done", branch: "done" });
		put({ id: "merged", branch: "merged" });
		put({ id: "none", branch: "none" });
		gh.byRef.set("run", {
			pr: pr({ number: 1, checks: "running" }),
			error: null,
		});
		gh.byRef.set("done", { pr: pr({ number: 2 }), error: null });
		gh.byRef.set("merged", {
			pr: pr({ number: 3, state: "MERGED" }),
			error: null,
		});
		for (const id of ["run", "done", "merged", "none"])
			await watcher.refresh(id);
		gh.refs = [];
		const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
		watcher.poll("/repos/demo");
		await settle();
		watcher.poll("/repos/demo");
		await settle();
		expect(gh.refs).toEqual(["run", "run"]);
		watcher.poll("/repos/demo");
		await settle();
		expect(gh.refs.sort()).toEqual(["done", "run", "run", "run"]);
	});

	test("polling stops once no map of the repo is open", async () => {
		const polling = new PrWatcher({
			storage,
			gh,
			reviewers: [],
			change: (session, patch) => {
				const next = { ...session, ...patch };
				storage.sessions.put(next);
				return next;
			},
			broadcast: () => {},
			propose: () => {},
			log: () => {},
			debounceMs: 0,
			heads: async (s) => [s.branch as string],
			watching: () => watching,
			pollMs: 5,
		});
		put({ id: "s1", pr: pr({ checks: "running" }) });
		gh.lookup = { pr: pr({ checks: "running" }), error: null };
		polling.watch("/repos/demo");
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(gh.calls).toBeGreaterThan(0);
		watching = false;
		await new Promise((resolve) => setTimeout(resolve, 15));
		const calls = gh.calls;
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(gh.calls).toBe(calls);
		polling.stop();
	});

	test("a session archived while gh answers keeps its row", async () => {
		put({ id: "s1" });
		gh.lookup = { pr: pr(), error: null };
		const pending = watcher.refresh("s1");
		const s = storage.sessions.get("s1") as Session;
		storage.sessions.put({ ...s, status: "archived" });
		await pending;
		expect(storage.sessions.get("s1")).toMatchObject({
			status: "archived",
			pr: null,
		});
	});
});

describe("resolveHeads", () => {
	const git = (cwd: string, ...args: string[]) => {
		const out = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
		if (out.exitCode !== 0) throw new Error(out.stderr.toString());
		return out.stdout.toString().trim();
	};

	test("follows the worktree's branch and its renamed upstream, not the base", () => {
		const root = mkdtempSync(join(dir, "git-"));
		const origin = join(root, "origin.git");
		const repo = join(root, "repo");
		git(root, "init", "-q", "--bare", "-b", "main", origin);
		git(root, "init", "-q", "-b", "main", repo);
		git(
			repo,
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"init",
		);
		git(repo, "remote", "add", "origin", origin);
		git(repo, "push", "-q", "-u", "origin", "main");
		git(repo, "remote", "set-head", "origin", "main");
		// As serenity makes it: branch x from origin/main, which it then tracks.
		const wt = join(root, "repo-x");
		git(repo, "worktree", "add", "-q", "-b", "x", wt, "origin/main");
		const session = makeSession({ repo, worktree: wt, cwd: wt, branch: "x" });
		return (async () => {
			expect(await resolveHeads(session)).toEqual(["x"]);
			// The agent moved the work to docs/x and pushed it.
			git(wt, "checkout", "-q", "-b", "docs/x");
			git(wt, "push", "-q", "-u", "origin", "docs/x");
			expect(await resolveHeads(session)).toEqual(["docs/x", "x"]);
			// Pushed under another name: local y → origin/fix/y.
			git(wt, "checkout", "-q", "-b", "y");
			git(wt, "push", "-q", "-u", "origin", "y:fix/y");
			expect(await resolveHeads({ ...session, branch: "y" })).toEqual([
				"fix/y",
				"y",
			]);
			// A fork: two remotes, so owner:branch is tried too.
			git(repo, "remote", "set-url", "origin", "git@github.com:me/r.git");
			git(repo, "remote", "add", "upstream", "https://github.com/org/r.git");
			expect(await resolveHeads({ ...session, branch: "y" })).toEqual([
				"fix/y",
				"y",
				"me:fix/y",
			]);
		})();
	});

	test("a removed worktree falls back to the session's branch", async () => {
		const session = makeSession({ worktree: join(dir, "gone"), branch: "x" });
		expect(await resolveHeads(session)).toEqual(["x"]);
	});
});

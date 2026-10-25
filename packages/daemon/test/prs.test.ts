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
import { PrWatcher } from "../src/prs";

class FakeGh extends Gh {
	lookup: PrLookup = { pr: null, error: null };
	override async prForBranch(): Promise<PrLookup> {
		return this.lookup;
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
	});
});

describe("PrWatcher", () => {
	test("stores the PR, or the reason it could not be read", async () => {
		put({ id: "s1" });
		gh.lookup = { pr: pr({ checks: "running" }), error: null };
		await watcher.refresh("s1");
		expect(storage.sessions.get("s1")?.pr?.number).toBe(42);
		gh.lookup = { pr: null, error: "gh not logged in" };
		await watcher.refresh("s1");
		expect(storage.sessions.get("s1")).toMatchObject({
			pr: null,
			prError: "gh not logged in",
		});
	});

	test("a merged PR makes an idle session finished", async () => {
		put({ id: "s1", status: "idle" });
		gh.lookup = { pr: pr({ state: "MERGED" }), error: null };
		await watcher.refresh("s1");
		expect(storage.sessions.get("s1")?.status).toBe("done");
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
});

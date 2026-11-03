import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSession } from "@serenity/core/testing";
import { resolveBase } from "../src/git";
import { resolveHeads } from "../src/prs";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sbase-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => {
	const out = Bun.spawnSync(
		["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
		{ cwd, stderr: "pipe" },
	);
	if (out.exitCode !== 0) throw new Error(out.stderr.toString());
	return out.stdout.toString().trim();
};

/**
 * A repo whose origin has main (its HEAD) and develop; locally there is
 * main and a local-only branch "spike", and the checkout is on "feature".
 */
let repo = "";
beforeAll(() => {
	const origin = join(dir, "origin.git");
	repo = join(dir, "repo");
	git(dir, "init", "-q", "--bare", "-b", "main", origin);
	git(dir, "init", "-q", "-b", "main", repo);
	git(repo, "commit", "-q", "--allow-empty", "-m", "init");
	git(repo, "remote", "add", "origin", origin);
	git(repo, "push", "-q", "-u", "origin", "main");
	git(repo, "push", "-q", "origin", "main:develop");
	git(repo, "remote", "set-head", "origin", "main");
	git(repo, "fetch", "-q", "origin");
	git(repo, "branch", "spike");
	git(repo, "switch", "-q", "-c", "feature");
});

describe("resolveBase (ADR 0058)", () => {
	test("the repo default is origin's HEAD", async () => {
		expect(await resolveBase(repo, "default")).toEqual({
			ref: "origin/main",
			branch: "main",
			notice: null,
		});
	});

	test("current is the main checkout's branch", async () => {
		expect(await resolveBase(repo, "current")).toEqual({
			ref: "feature",
			branch: "feature",
			notice: null,
		});
	});

	test("a named branch: local first, else origin's", async () => {
		expect(await resolveBase(repo, { branch: "spike" })).toEqual({
			ref: "spike",
			branch: "spike",
			notice: null,
		});
		expect(await resolveBase(repo, { branch: "develop" })).toEqual({
			ref: "origin/develop",
			branch: "develop",
			notice: null,
		});
	});

	test("a branch that is nowhere falls back to the repo default with a notice", async () => {
		expect(await resolveBase(repo, { branch: "gone" })).toEqual({
			ref: "origin/main",
			branch: "main",
			notice: "no branch gone here or on origin; using origin/main",
		});
	});

	test("a detached main checkout falls back too", async () => {
		const detached = join(dir, "detached");
		git(dir, "clone", "-q", join(dir, "origin.git"), detached);
		git(detached, "switch", "-q", "--detach");
		expect(await resolveBase(detached, "current")).toEqual({
			ref: "origin/main",
			branch: "main",
			notice: "the main checkout is on no branch; using origin/main",
		});
	});

	test("the dialog's override wins over the setting, and is refused if it is nowhere", async () => {
		expect(await resolveBase(repo, "current", " develop ")).toEqual({
			ref: "origin/develop",
			branch: "develop",
			notice: null,
		});
		expect(await resolveBase(repo, "current", "")).toMatchObject({
			ref: "feature",
		});
		await expect(resolveBase(repo, "default", "gone")).rejects.toThrow(
			"no branch gone here or on origin to start from",
		);
	});
});

test("a session off develop never looks for its PR under develop (ADR 0055, 0058)", async () => {
	const wt = join(dir, "repo-x");
	git(repo, "worktree", "add", "-q", "-b", "develop", wt, "origin/develop");
	// Its branch is named like its base and tracks it: the base's PRs are not its own.
	const session = makeSession({
		repo,
		worktree: wt,
		cwd: wt,
		branch: "develop",
		base: { ref: "origin/develop", branch: "develop" },
	});
	expect(await resolveHeads(session)).toEqual([]);
	// Before the base was recorded, only the repo default was ruled out.
	expect(await resolveHeads({ ...session, base: null })).toEqual(["develop"]);
});

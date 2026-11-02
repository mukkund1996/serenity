import { describe, expect, test } from "bun:test";
import { makeSession } from "@serenity/core/testing";
import {
	myPullRequests,
	ownersFor,
	type PrInfo,
	parseCodeowners,
	parsePr,
	parseReviewRequests,
	prHeads,
	prLabel,
	prStatus,
	remoteOwner,
	reviewerCandidates,
	rollupChecks,
	touchesPr,
	wantsReviewer,
} from "../src/pr";

const run = (status: string, conclusion: string | null = null) => ({
	__typename: "CheckRun",
	status,
	conclusion,
});
const ctx = (state: string) => ({ __typename: "StatusContext", state });

describe("rollupChecks", () => {
	test("failure wins, then running, then passing; none without checks", () => {
		expect(
			rollupChecks([run("COMPLETED", "SUCCESS"), run("COMPLETED", "FAILURE")]),
		).toBe("failing");
		expect(rollupChecks([run("COMPLETED", "SUCCESS"), ctx("ERROR")])).toBe(
			"failing",
		);
		expect(
			rollupChecks([run("COMPLETED", "SUCCESS"), run("IN_PROGRESS")]),
		).toBe("running");
		expect(rollupChecks([run("COMPLETED", "SUCCESS"), ctx("PENDING")])).toBe(
			"running",
		);
		expect(
			rollupChecks([
				run("COMPLETED", "SUCCESS"),
				run("COMPLETED", "SKIPPED"),
				ctx("SUCCESS"),
			]),
		).toBe("passing");
		expect(rollupChecks([])).toBe("none");
		expect(rollupChecks(null)).toBe("none");
	});
});

const raw = {
	number: 482,
	url: "https://github.com/o/r/pull/482",
	title: "Rotate refresh tokens",
	state: "OPEN",
	isDraft: false,
	statusCheckRollup: [run("COMPLETED", "SUCCESS")],
	reviewDecision: "REVIEW_REQUIRED",
	reviewRequests: [
		{ __typename: "User", login: "babakks" },
		{ __typename: "Team", slug: "o/core" },
	],
	latestReviews: [],
	author: { login: "me" },
	headRefOid: "abc123",
	baseRefName: "main",
	files: [{ path: "src/a.ts" }],
};

describe("parsePr", () => {
	test("keeps what cards and the master need", () => {
		expect(parsePr(raw)).toEqual({
			number: 482,
			url: "https://github.com/o/r/pull/482",
			title: "Rotate refresh tokens",
			state: "OPEN",
			isDraft: false,
			checks: "passing",
			reviewDecision: "REVIEW_REQUIRED",
			reviewRequests: ["babakks", "o/core"],
			reviewed: false,
			author: "me",
			headRefOid: "abc123",
			baseRefName: "main",
			files: ["src/a.ts"],
		});
		expect(parsePr({ nope: 1 })).toBeNull();
		expect(parsePr({ ...raw, reviewDecision: "" })?.reviewDecision).toBeNull();
	});
});

describe("prStatus", () => {
	const pr = parsePr(raw) as NonNullable<ReturnType<typeof parsePr>>;
	test("uses the design's words, most important first", () => {
		expect(prStatus({ ...pr, state: "MERGED" })).toEqual({
			text: "merged",
			tone: "merged",
		});
		expect(prStatus({ ...pr, isDraft: true, checks: "failing" }).text).toBe(
			"draft",
		);
		expect(
			prStatus({ ...pr, checks: "failing", reviewDecision: "APPROVED" }),
		).toEqual({ text: "checks failing", tone: "bad" });
		expect(prStatus({ ...pr, checks: "running" }).text).toBe("checks running");
		expect(prStatus({ ...pr, reviewDecision: "APPROVED" })).toEqual({
			text: "approved",
			tone: "good",
		});
		expect(prStatus(pr)).toEqual({ text: "checks passing", tone: "good" });
		expect(prStatus({ ...pr, checks: "none", reviewDecision: null }).text).toBe(
			"open",
		);
	});

	test("a PR wants a reviewer only when it is ready and nobody is on it", () => {
		expect(wantsReviewer({ ...pr, reviewRequests: [] })).toBe(true);
		expect(wantsReviewer(pr)).toBe(false);
		expect(
			wantsReviewer({ ...pr, reviewRequests: [], checks: "running" }),
		).toBe(false);
		expect(wantsReviewer({ ...pr, reviewRequests: [], isDraft: true })).toBe(
			false,
		);
		expect(wantsReviewer({ ...pr, reviewRequests: [], reviewed: true })).toBe(
			false,
		);
		expect(wantsReviewer({ ...pr, reviewRequests: [], state: "MERGED" })).toBe(
			false,
		);
	});
});

describe("CODEOWNERS", () => {
	const rules = parseCodeowners(`
# default owners
*            @alice
*.ts         @carol   # every TypeScript file
/docs/       @bob
src/api/     @dave @o/api-team
`);

	test("the last matching rule wins per file", () => {
		expect(ownersFor(rules, ["README.md"])).toEqual(["alice"]);
		expect(ownersFor(rules, ["src/util/x.ts"])).toEqual(["carol"]);
		expect(ownersFor(rules, ["docs/guide.md"])).toEqual(["bob"]);
		expect(ownersFor(rules, ["src/docs/x.md"])).toEqual(["alice"]);
		expect(ownersFor(rules, ["src/api/routes.ts"])).toEqual([
			"dave",
			"o/api-team",
		]);
		expect(ownersFor(rules, ["README.md", "docs/a.md", "README.md"])).toEqual([
			"alice",
			"bob",
		]);
	});

	test("candidates: owners, then config, without the author, me or anyone asked", () => {
		expect(
			reviewerCandidates({
				codeowners: ["alice", "me"],
				configured: ["@bob", "alice"],
				exclude: ["Me", null],
			}),
		).toEqual(["alice", "bob"]);
	});
});

describe("the master's GitHub", () => {
	test("review requests: newest updated first, at most three, junk dropped", () => {
		const item = (number: number, updatedAt: string) => ({
			number,
			url: `https://github.com/o/r/pull/${number}`,
			title: `t${number}`,
			author: { login: "ana" },
			updatedAt,
		});
		const parsed = parseReviewRequests([
			item(1, "2026-10-20T10:00:00Z"),
			item(2, "2026-10-25T10:00:00Z"),
			{ title: "no number" },
			item(3, "2026-10-22T10:00:00Z"),
			item(4, "2026-10-24T10:00:00Z"),
		]);
		expect(parsed.map((r) => r.number)).toEqual([2, 4, 3]);
		expect(parsed[0]).toEqual({
			number: 2,
			url: "https://github.com/o/r/pull/2",
			title: "t2",
			author: "ana",
			updatedAt: Date.parse("2026-10-25T10:00:00Z"),
		});
		expect(parseReviewRequests({})).toEqual([]);
	});

	test("my PRs: open, mine, one row per PR, newest first, never archived", () => {
		const pr = (number: number, more: Partial<PrInfo> = {}): PrInfo => ({
			number,
			url: `u${number}`,
			title: `t${number}`,
			state: "OPEN",
			isDraft: false,
			checks: "passing",
			reviewDecision: null,
			reviewRequests: [],
			reviewed: false,
			author: "Me",
			headRefOid: "",
			baseRefName: "main",
			files: [],
			...more,
		});
		const sessions = [
			makeSession({ id: "a", pr: pr(3) }),
			makeSession({ id: "b", pr: pr(5) }),
			makeSession({ id: "shared", pr: pr(5) }),
			makeSession({ id: "merged", pr: pr(6, { state: "MERGED" }) }),
			makeSession({ id: "theirs", pr: pr(7, { author: "bob" }) }),
			makeSession({ id: "old", pr: pr(8), status: "archived" }),
			makeSession({ id: "none", pr: null }),
		];
		const ids = (user: string | null) =>
			myPullRequests(sessions, user).map((m) => m.session.id);
		expect(ids("me")).toEqual(["b", "a"]);
		// Before gh names the user, every open PR counts.
		expect(ids(null)).toEqual(["theirs", "b", "a"]);
	});
});

describe("prHeads", () => {
	const b = (
		name: string,
		upstream: string | null = null,
		remote = "origin",
	) => ({
		name,
		upstream,
		remote: upstream ? remote : null,
	});

	test("the worktree's branch, then the session's, never the base", () => {
		expect(
			prHeads({
				branches: [b("fix/x", "main"), b("x", "main")],
				base: "main",
				owners: {},
			}),
		).toEqual(["fix/x", "x"]);
		expect(
			prHeads({ branches: [b("main")], base: "main", owners: {} }),
		).toEqual([]);
		expect(
			prHeads({ branches: [b("HEAD")], base: "main", owners: {} }),
		).toEqual([]);
	});

	test("an upstream counts only when it is the same work renamed", () => {
		expect(
			prHeads({ branches: [b("x", "docs/x")], base: "main", owners: {} }),
		).toEqual(["docs/x", "x"]);
		// Started from develop, not pushed as it: develop's PRs are not ours.
		expect(
			prHeads({ branches: [b("x", "develop")], base: "main", owners: {} }),
		).toEqual(["x"]);
	});

	test("with a fork's remotes, each head is also tried as owner:branch", () => {
		expect(
			prHeads({
				branches: [b("fix/x", "fix/x", "origin")],
				base: "main",
				owners: { origin: "me", upstream: "org" },
			}),
		).toEqual(["fix/x", "me:fix/x"]);
		expect(
			prHeads({
				branches: [b("fix/x", "fix/x")],
				base: "main",
				owners: { origin: "me" },
			}),
		).toEqual(["fix/x"]);
	});
});

describe("remoteOwner", () => {
	test("reads https and ssh GitHub URLs", () => {
		expect(remoteOwner("https://github.com/acme/serenity.git")).toBe("acme");
		expect(remoteOwner("git@github.com:acme/serenity.git")).toBe("acme");
		expect(remoteOwner("https://github.com/acme/serenity")).toBe("acme");
		expect(remoteOwner("/local/path")).toBeNull();
	});
});

describe("touchesPr", () => {
	const bash = (command: string) => ({
		tool_name: "Bash",
		tool_input: { command },
	});
	test("pushes and gh pr changes, not reads or other tools", () => {
		expect(touchesPr(bash("git push -u origin fix/x"))).toBe(true);
		expect(touchesPr(bash("git -C /w push"))).toBe(true);
		expect(touchesPr(bash("bun test && gh pr create --fill"))).toBe(true);
		expect(touchesPr(bash("gh pr merge 74 --squash"))).toBe(true);
		expect(touchesPr(bash("gh pr view 74"))).toBe(false);
		expect(touchesPr(bash("git status"))).toBe(false);
		expect(
			touchesPr({ tool_name: "Edit", tool_input: { command: "git push" } }),
		).toBe(false);
	});
});

describe("prLabel", () => {
	test("is the number with PR in front", () => {
		expect(prLabel({ number: 74 })).toBe("PR #74");
	});
});

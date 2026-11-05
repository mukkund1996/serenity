import { describe, expect, test } from "bun:test";
import { makeSession } from "@serenity/core/testing";
import { type PrInfo, parsePr } from "../src/pr";
import {
	parseOpenPrs,
	parsePrDetailExtra,
	prDetailText,
	prOverviewText,
	sessionsFor,
} from "../src/pr-overview";

const passed = [
	{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
];
const failed = [
	{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
];

/** `gh pr list --state open --json <OPEN_PR_FIELDS>`, as gh prints it. */
const LIST = [
	{
		number: 41,
		url: "https://github.com/o/r/pull/41",
		title: "Add rate limits to the API",
		author: { login: "ana", is_bot: false },
		isDraft: false,
		statusCheckRollup: passed,
		reviewDecision: "REVIEW_REQUIRED",
		reviewRequests: [{ __typename: "User", login: "Me" }],
		headRefName: "rate-limits",
		updatedAt: "2026-11-05T10:00:00Z",
	},
	{
		number: 40,
		url: "https://github.com/o/r/pull/40",
		title: "Fix the login redirect",
		author: { login: "me" },
		isDraft: false,
		statusCheckRollup: failed,
		reviewDecision: "CHANGES_REQUESTED",
		reviewRequests: [],
		headRefName: "fix-login",
		updatedAt: "2026-11-05T09:00:00Z",
	},
	{
		number: 39,
		url: "https://github.com/o/r/pull/39",
		title: "Docs for the settings panel",
		author: { login: "me" },
		isDraft: true,
		statusCheckRollup: [],
		reviewDecision: "",
		reviewRequests: [],
		headRefName: "settings-docs",
		updatedAt: "2026-11-05T08:00:00Z",
	},
	{
		number: 38,
		url: "https://github.com/o/r/pull/38",
		title: "Bump deps",
		author: { login: "bob" },
		isDraft: false,
		statusCheckRollup: passed,
		reviewDecision: "APPROVED",
		reviewRequests: [{ __typename: "Team", slug: "o/core" }],
		headRefName: "deps",
		updatedAt: "2026-11-05T07:00:00Z",
	},
	{
		number: 37,
		url: "https://github.com/o/r/pull/37",
		title: "Team-requested change",
		author: { login: "cy" },
		isDraft: false,
		statusCheckRollup: passed,
		reviewDecision: null,
		reviewRequests: [{ __typename: "Team", slug: "o/web" }],
		headRefName: "team",
		updatedAt: "2026-11-05T06:00:00Z",
	},
	{ title: "not a PR" },
];

describe("parseOpenPrs", () => {
	test("reads gh's list, newest updated first, skipping what is not a PR", () => {
		const prs = parseOpenPrs([...LIST].reverse());
		expect(prs.map((p) => p.number)).toEqual([41, 40, 39, 38, 37]);
		expect(prs[0]).toEqual({
			number: 41,
			url: "https://github.com/o/r/pull/41",
			title: "Add rate limits to the API",
			author: "ana",
			isDraft: false,
			checks: "passing",
			reviewDecision: "REVIEW_REQUIRED",
			reviewRequests: ["Me"],
			headRefName: "rate-limits",
			updatedAt: Date.parse("2026-11-05T10:00:00Z"),
		});
		expect(prs[1]?.checks).toBe("failing");
		expect(prs[2]).toMatchObject({ isDraft: true, checks: "none" });
		expect(prs[2]?.reviewDecision).toBeNull();
		expect(prs[3]?.reviewRequests).toEqual(["o/core"]);
		expect(parseOpenPrs({})).toEqual([]);
	});
});

describe("prOverviewText", () => {
	const fixLogin = makeSession({
		name: "fix-login",
		branch: "fix-login",
		status: "waiting",
		waitingOn: "question",
	});
	const docs = makeSession({
		name: "settings-docs",
		branch: "other-name",
		pr: parsePr({ number: 39, url: "u" }),
	});
	const gone = makeSession({
		name: "old-deps",
		branch: "deps",
		status: "archived",
	});

	test("groups every open PR into needs you, yours and others, one line each", () => {
		const text = prOverviewText({
			prs: parseOpenPrs(LIST),
			sessions: [fixLogin, docs, gone],
			user: "me",
			requested: [37],
			truncated: false,
		});
		expect(text).toBe(
			[
				"Open PRs: 5 (you are me).",
				"Needs you (3):",
				'- #41 "Add rate limits to the API" by ana · no session · checks passing · review requested from you · waits on you: your review is requested',
				'- #40 "Fix the login redirect" by you · session fix-login · checks failing · changes requested · waits on you: address the requested changes; fix the failing checks; fix-login waits on you (question)',
				'- #37 "Team-requested change" by cy · no session · checks passing · review requested from o/web · waits on you: your review is requested',
				"Yours (1):",
				'- #39 "Docs for the settings panel" by you · session settings-docs · draft · no checks · no review yet',
				"Others (1):",
				'- #38 "Bump deps" by bob · no session · checks passing · approved',
				"Answer with this grouped, one short line per PR; leave out empty groups. For one PR in depth, call pr_overview with pr set to its number.",
			].join("\n"),
		);
	});

	test("an approved PR of yours with passing checks is ready to merge", () => {
		const prs = parseOpenPrs([
			{ ...LIST[3], author: { login: "me" }, reviewRequests: [] },
		]);
		const text = prOverviewText({
			prs,
			sessions: [],
			user: "me",
			requested: [],
			truncated: true,
		});
		expect(text).toContain("Open PRs: 1+ (you are me).");
		expect(text).toContain("waits on you: approved, ready to merge");
		expect(text).toContain("Yours: none.");
		expect(text).toContain("Only the 50 most recently updated open PRs");
	});

	test("without a known user, PRs with a session count as yours", () => {
		const text = prOverviewText({
			prs: parseOpenPrs(LIST.slice(2, 4)),
			sessions: [docs],
			user: null,
			requested: [],
			truncated: false,
		});
		expect(text).toContain("(gh user unknown)");
		expect(text).toMatch(
			/Yours \(1\):\n- #39 .* by me · session settings-docs/,
		);
		expect(text).toMatch(/Others \(1\):\n- #38/);
	});

	test("a big group shows ten lines and counts the rest", () => {
		const many = Array.from({ length: 13 }, (_, i) => ({
			...LIST[3],
			number: 100 + i,
		}));
		const text = prOverviewText({
			prs: parseOpenPrs(many),
			sessions: [],
			user: "me",
			requested: [],
			truncated: false,
		});
		expect(text.split("\n").filter((l) => l.startsWith("- #"))).toHaveLength(
			10,
		);
		expect(text).toContain("- and 3 more");
	});

	test("no open PRs says so", () => {
		expect(
			prOverviewText({
				prs: [],
				sessions: [],
				user: "me",
				requested: [],
				truncated: false,
			}),
		).toBe("No open PRs in this repo.");
	});
});

test("sessionsFor: its stored PR first, else a session on the PR's branch without one", () => {
	const a = makeSession({
		name: "a",
		branch: "x",
		pr: parsePr({ number: 9, url: "u" }),
	});
	const b = makeSession({ name: "b", branch: "x" });
	expect(sessionsFor({ number: 9, headRefName: "x" }, [a, b])).toEqual([a]);
	expect(sessionsFor({ number: 8, headRefName: "x" }, [a, b])).toEqual([b]);
	expect(sessionsFor({ number: 8, headRefName: "" }, [a, b])).toEqual([]);
});

describe("prDetailText", () => {
	/** `gh pr view 41 --json <PR_FIELDS>,<PR_DETAIL_EXTRA>`. */
	const VIEW = {
		...LIST[0],
		state: "OPEN",
		latestReviews: [],
		headRefOid: "abc",
		baseRefName: "main",
		files: Array.from({ length: 17 }, (_, i) => ({ path: `src/f${i}.ts` })),
		body: "Adds a token bucket per API key.\n\nCloses #12.",
		additions: 120,
		deletions: 30,
	};

	test("one PR in depth: who, where, state, size, files and its description", () => {
		const text = prDetailText({
			pr: parsePr(VIEW) as PrInfo,
			extra: parsePrDetailExtra(VIEW),
			sessions: [makeSession({ name: "limits", branch: "rate-limits" })],
			user: "me",
		});
		const lines = text.split("\n");
		expect(lines[0]).toBe(
			'#41 "Add rate limits to the API" by ana · open · rate-limits → main',
		);
		expect(lines[1]).toBe(
			"session limits · checks passing · review requested from you, nobody has reviewed yet",
		);
		expect(lines[2]).toBe("https://github.com/o/r/pull/41");
		expect(lines[3]).toStartWith("+120 −30 in 17 files: src/f0.ts, ");
		expect(lines[3]).toEndWith("src/f14.ts, and 2 more");
		expect(lines[4]).toBe(
			"Description: Adds a token bucket per API key. Closes #12.",
		);
		expect(lines[5]).toContain("gh pr diff 41");
	});

	test("an empty description says so", () => {
		const raw = { ...VIEW, body: "", files: [{ path: "a" }] };
		const text = prDetailText({
			pr: parsePr(raw) as PrInfo,
			extra: parsePrDetailExtra(raw),
			sessions: [],
			user: "ana",
		});
		expect(text).toContain("by you · open");
		expect(text).toContain("in 1 file: a");
		expect(text).toContain("No description.");
	});
});

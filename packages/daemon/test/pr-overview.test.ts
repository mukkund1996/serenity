import { beforeEach, expect, test } from "bun:test";
import {
	createMemoryStorage,
	type OpenPr,
	type PrDetailExtra,
	type PrInfo,
	parseOpenPrs,
	parsePr,
	parsePrDetailExtra,
	type ReviewRequest,
	type Storage,
} from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import { Gh } from "../src/gh";
import { OVERVIEW_CACHE_MS, PrOverview, prArg } from "../src/pr-overview";

const REPO = "/repos/demo";

/** A gh that answers from fixture JSON, as `gh pr list` and `gh pr view` print it. */
class FakeGh extends Gh {
	listCalls = 0;
	list: { prs: OpenPr[]; truncated: boolean; error: string | null } = {
		prs: [],
		truncated: false,
		error: null,
	};
	detail: {
		pr: PrInfo | null;
		extra: PrDetailExtra | null;
		error: string | null;
	} = { pr: null, extra: null, error: "no PR" };
	override async openPrs() {
		this.listCalls++;
		return this.list;
	}
	override async prDetail() {
		return this.detail;
	}
	override async currentUser(): Promise<string | null> {
		return "me";
	}
}

const LIST = [
	{
		number: 7,
		url: "https://github.com/o/r/pull/7",
		title: "Mine",
		author: { login: "me" },
		statusCheckRollup: [],
		reviewRequests: [],
		headRefName: "mine",
		updatedAt: "2026-11-05T10:00:00Z",
	},
	{
		number: 5,
		url: "https://github.com/o/r/pull/5",
		title: "Theirs, team asks me",
		author: { login: "ana" },
		statusCheckRollup: [],
		reviewRequests: [{ slug: "o/web" }],
		headRefName: "theirs",
		updatedAt: "2026-11-05T09:00:00Z",
	},
];

let gh: FakeGh;
let storage: Storage;
let now: number;
let reviews: ReviewRequest[];
let overview: PrOverview;

beforeEach(() => {
	gh = new FakeGh();
	storage = createMemoryStorage();
	now = 1_000_000;
	reviews = [];
	overview = new PrOverview({
		storage,
		gh,
		reviewRequests: () => reviews,
		now: () => now,
	});
});

test("joins gh's open PRs with the map's sessions and the polled review requests", async () => {
	gh.list = { prs: parseOpenPrs(LIST), truncated: false, error: null };
	storage.sessions.put(
		makeSession({ repo: REPO, name: "mine-s", branch: "mine" }),
	);
	reviews = [{ number: 5, url: "u", title: "t", author: "ana", updatedAt: 0 }];
	const out = await overview.answer(REPO, null);
	expect(out.isError).toBeUndefined();
	expect(out.text).toContain("Needs you (1):\n- #5 ");
	expect(out.text).toContain("waits on you: your review is requested");
	expect(out.text).toContain('Yours (1):\n- #7 "Mine" by you · session mine-s');
});

test("a second ask within the cache window reuses the last read", async () => {
	gh.list = { prs: parseOpenPrs(LIST), truncated: false, error: null };
	await overview.answer(REPO, null);
	now += OVERVIEW_CACHE_MS - 1;
	await overview.answer(REPO, null);
	expect(gh.listCalls).toBe(1);
	now += 1;
	await overview.answer(REPO, null);
	expect(gh.listCalls).toBe(2);
});

test("gh not logged in says so, as a tool error", async () => {
	gh.list = { prs: [], truncated: false, error: "gh not logged in" };
	const out = await overview.answer(REPO, null);
	expect(out).toEqual({
		text: "gh is not logged in, so serenity cannot read the open PRs. Tell the user to run gh auth login in a terminal.",
		isError: true,
	});
});

test("a failure after a good read keeps the last list, said to be old", async () => {
	gh.list = { prs: parseOpenPrs(LIST), truncated: false, error: null };
	await overview.answer(REPO, null);
	now += 3 * 60_000;
	gh.list = { prs: [], truncated: false, error: "HTTP 502: Bad Gateway" };
	const out = await overview.answer(REPO, null);
	expect(out.isError).toBeUndefined();
	expect(out.text).toStartWith(
		"From 3 min ago; gh failed just now: HTTP 502: Bad Gateway.\nOpen PRs: 2",
	);
});

test("with a PR number, that PR in depth; a missing one is an error", async () => {
	const raw = {
		...LIST[1],
		state: "OPEN",
		baseRefName: "main",
		files: [{ path: "a.ts" }],
		body: "Why it changes",
		additions: 3,
		deletions: 1,
	};
	gh.detail = {
		pr: parsePr(raw),
		extra: parsePrDetailExtra(raw),
		error: null,
	};
	const out = await overview.answer(REPO, 5);
	expect(out.text).toStartWith(
		'#5 "Theirs, team asks me" by ana · open · theirs → main',
	);
	expect(out.text).toContain("Description: Why it changes");

	gh.detail = { pr: null, extra: null, error: "no PR #99" };
	expect(await overview.answer(REPO, 99)).toEqual({
		text: "Could not read PR #99: no PR #99.",
		isError: true,
	});
});

test("prArg takes 123, '123' and '#123'; anything else is invalid", () => {
	expect(prArg(undefined)).toBeNull();
	expect(prArg(123)).toBe(123);
	expect(prArg("123")).toBe(123);
	expect(prArg(" #123 ")).toBe(123);
	expect(prArg("abc")).toBe("invalid");
	expect(prArg(1.5)).toBe("invalid");
	expect(prArg(0)).toBe("invalid");
});

test("a real gh that is missing reads as not installed", async () => {
	const missing = new Gh("/nonexistent/gh");
	expect((await missing.openPrs("/tmp")).error).toBe("gh not installed");
	expect((await missing.prDetail("/tmp", 1)).error).toBe("gh not installed");
});

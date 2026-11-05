import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ago,
	groupByRepo,
	type HistorySession,
	historyLabel,
	inWindow,
	isImportable,
	parseDateArg,
	parseRunningClaude,
	readTranscriptHead,
	readTranscriptTail,
	underDir,
} from "../src";

const fixture = (name: string) =>
	readFileSync(join(import.meta.dir, "fixtures/history", name), "utf8");

describe("readTranscriptHead", () => {
	test("finds where it ran and the first prompt the user typed", () => {
		const head = readTranscriptHead(fixture("cli-session.jsonl"));
		expect(head).toEqual({
			sessionId: "5f0c2d1e-1111-4a5b-9c3d-000000000001",
			cwd: "/work/demo-login",
			branch: "fix/login",
			entrypoint: "cli",
			startedAt: Date.parse("2026-11-03T08:31:25.481Z"),
			// Not the caveat (meta) nor the /model wrapper; text blocks join on one line.
			firstPrompt: "Fix the login redirect: after sign-in users land on /404",
			sidechain: false,
		});
	});

	test("the tail gives the title, the last prompt and the latest branch", () => {
		const tail = readTranscriptTail(fixture("cli-session.jsonl"));
		expect(tail.title).toBe("Fix login redirect");
		expect(tail.lastPrompt).toBe("also add a test");
		expect(tail.branch).toBe("fix/login-tests");
	});

	test("a cut-off first chunk still parses", () => {
		const text = fixture("cli-session.jsonl");
		const head = readTranscriptHead(text.slice(0, text.indexOf("Looking")));
		expect(head.firstPrompt).toStartWith("Fix the login redirect");
	});

	test("garbage and empty text give nothing", () => {
		expect(readTranscriptHead("not json\n{oops").sessionId).toBeNull();
		expect(readTranscriptHead("").firstPrompt).toBeNull();
	});
});

describe("isImportable", () => {
	test("a conversation the user had", () => {
		const head = readTranscriptHead(fixture("cli-session.jsonl"));
		expect(isImportable(head, null)).toBe(true);
	});

	test("not headless runs, subagents, or sessions with nothing said", () => {
		for (const name of ["headless.jsonl", "subagent.jsonl", "empty.jsonl"])
			expect(isImportable(readTranscriptHead(fixture(name)), null)).toBe(false);
	});

	test("a title alone is enough to show it", () => {
		const head = readTranscriptHead(fixture("empty.jsonl"));
		expect(isImportable(head, "Named it")).toBe(true);
	});

	test("an old transcript without entrypoint counts", () => {
		const head = {
			...readTranscriptHead(fixture("cli-session.jsonl")),
			entrypoint: null,
		};
		expect(isImportable(head, null)).toBe(true);
	});
});

describe("filters", () => {
	const s = { startedAt: 100, lastActiveAt: 200 };
	test("inWindow: open at some point in the range", () => {
		expect(inWindow(s)).toBe(true);
		expect(inWindow(s, 150, 160)).toBe(true);
		expect(inWindow(s, 201)).toBe(false);
		expect(inWindow(s, undefined, 99)).toBe(false);
		expect(inWindow(s, 200, 100)).toBe(true);
	});

	test("underDir: the folder itself or below, not a sibling with the same prefix", () => {
		expect(underDir("/w/demo", "/w/demo")).toBe(true);
		expect(underDir("/w/demo/api", "/w/demo/")).toBe(true);
		expect(underDir("/w/demo-api", "/w/demo")).toBe(false);
		expect(underDir("/anything", "/")).toBe(true);
	});

	test("parseDateArg: a date is local midnight, or the day's end", () => {
		const start = parseDateArg("2026-11-03") as number;
		const end = parseDateArg("2026-11-03", true) as number;
		expect(new Date(start).getDate()).toBe(3);
		expect(new Date(start).getHours()).toBe(0);
		expect(end - start).toBe(86_400_000 - 1);
		expect(parseDateArg("2026-11-03T10:00:00Z")).toBe(
			Date.parse("2026-11-03T10:00:00Z"),
		);
		expect(parseDateArg("whenever")).toBeNull();
		expect(parseDateArg(undefined)).toBeNull();
	});
});

describe("groupByRepo and labels", () => {
	const make = (
		id: string,
		repo: string,
		lastActiveAt: number,
	): HistorySession => ({
		claudeSessionId: id,
		cwd: repo,
		repo,
		branch: null,
		title: null,
		firstPrompt: `prompt ${id}`,
		lastPrompt: null,
		startedAt: 0,
		lastActiveAt,
		bytes: 1,
		runningPid: null,
		name: id,
	});

	test("the repo with the latest activity first, newest first within", () => {
		const groups = groupByRepo([
			make("a", "/r/one", 10),
			make("b", "/r/two", 30),
			make("c", "/r/one", 20),
		]);
		expect(groups.map((g) => [g.repo, g.sessions.map((s) => s.name)])).toEqual([
			["/r/two", ["b"]],
			["/r/one", ["c", "a"]],
		]);
	});

	test("label: title, else first prompt, else last prompt", () => {
		expect(historyLabel(make("a", "/r", 1))).toBe("prompt a");
		expect(historyLabel({ ...make("a", "/r", 1), title: "T" })).toBe("T");
		expect(
			historyLabel({ title: null, firstPrompt: null, lastPrompt: null }),
		).toBe("no prompt");
	});

	test("ago", () => {
		expect(ago(0, 20_000)).toBe("just now");
		expect(ago(0, 5 * 60_000)).toBe("5m ago");
		expect(ago(0, 3 * 3_600_000)).toBe("3h ago");
		expect(ago(0, 3 * 86_400_000)).toBe("3d ago");
	});
});

describe("parseRunningClaude", () => {
	test("any interactive claude, in tmux or a plain terminal", () => {
		const base = { kind: "interactive", pid: 7, sessionId: "s", cwd: "/w" };
		expect(parseRunningClaude(base)).toEqual({
			pid: 7,
			sessionId: "s",
			cwd: "/w",
			inTmux: false,
		});
		expect(parseRunningClaude({ ...base, tmux: "work:@3.%7" })?.inTmux).toBe(
			true,
		);
		expect(parseRunningClaude({ ...base, kind: "bg" })).toBeNull();
		expect(parseRunningClaude({ ...base, pid: "7" })).toBeNull();
	});
});

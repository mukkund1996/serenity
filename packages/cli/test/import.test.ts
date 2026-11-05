import { describe, expect, test } from "bun:test";
import type { HistorySession } from "@serenity/core";
import {
	formatHistory,
	type ImportArgs,
	parseImportArgs,
	pickNumbers,
} from "../src/import";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const DAY = 86_400_000;
const parse = (...argv: string[]) => parseImportArgs(argv, NOW) as ImportArgs;

describe("parseImportArgs", () => {
	test("defaults to this repo's last 14 days, asking which", () => {
		expect(parse()).toEqual({
			filter: { since: NOW - 14 * DAY },
			allRepos: false,
			list: false,
			yes: false,
			ids: [],
			help: false,
		});
	});

	test("options", () => {
		const a = parse("--days", "3", "--dir", "/w/api", "--all-repos", "--yes");
		expect(a.filter).toEqual({ since: NOW - 3 * DAY, dir: "/w/api" });
		expect(a.allRepos && a.yes).toBe(true);
		const b = parse("--since", "2026-11-01", "--until", "2026-11-02");
		expect(new Date(b.filter.since as number).getDate()).toBe(1);
		expect(new Date(b.filter.until as number).getHours()).toBe(23);
	});

	test("an --until or ids without --days look at all time", () => {
		expect(parse("--until", "2026-11-02").filter.since).toBeUndefined();
		expect(parse("5f0c2d1e").filter.since).toBeUndefined();
		expect(parse("5f0c2d1e").ids).toEqual(["5f0c2d1e"]);
	});

	test("errors", () => {
		expect(parseImportArgs(["--days", "x"])).toBe(
			"--days takes a positive number",
		);
		expect(parseImportArgs(["--since", "soon"])).toBe(
			"--since: not a date: soon",
		);
		expect(parseImportArgs(["--dir"])).toBe("--dir needs a value");
		expect(parseImportArgs(["--nope"])).toBe("unknown option --nope");
	});
});

describe("pickNumbers", () => {
	test("Enter is all, n is none, numbers and ranges", () => {
		expect(pickNumbers("", 3)).toEqual([1, 2, 3]);
		expect(pickNumbers("n", 3)).toEqual([]);
		expect(pickNumbers("3 1,2-2", 5)).toEqual([1, 2, 3]);
		expect(pickNumbers("2-4", 5)).toEqual([2, 3, 4]);
	});

	test("out of range or unreadable is null", () => {
		expect(pickNumbers("4", 3)).toBeNull();
		expect(pickNumbers("0", 3)).toBeNull();
		expect(pickNumbers("two", 3)).toBeNull();
	});
});

test("formatHistory numbers sessions by repo and flags the ones still open", () => {
	const s = (
		id: string,
		repo: string,
		extra: Partial<HistorySession> = {},
	): HistorySession => ({
		claudeSessionId: id,
		cwd: repo,
		repo,
		branch: "main",
		title: `title ${id}`,
		firstPrompt: null,
		lastPrompt: null,
		startedAt: 0,
		lastActiveAt: NOW - 2 * DAY,
		bytes: 1000,
		runningPid: null,
		name: `name-${id}`,
		...extra,
	});
	const order = [
		s("aaaaaaaa-1", "/w/demo", { bytes: 50 * 1024 * 1024 }),
		s("bbbbbbbb-2", "/w/other", { runningPid: 42 }),
	];
	expect(formatHistory({ sessions: order, gone: 2 }, order, NOW)).toBe(
		[
			"",
			"demo  (/w/demo)",
			"  1. name-aaaaaaaa-1  ·  main · 2d ago · 50 MB · aaaaaaaa",
			"     title aaaaaaaa-1",
			"",
			"other  (/w/other)",
			"  2. name-bbbbbbbb-2  ·  main · 2d ago · bbbbbbbb",
			"     title bbbbbbbb-2",
			"     still open in a terminal (pid 42): quit it there before resuming",
			"",
			"2 more left out: their folder is gone, so they cannot resume.",
		].join("\n"),
	);
});

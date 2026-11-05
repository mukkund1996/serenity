/**
 * The master's overview of a repo's open PRs (ADR 0061): every open PR, not
 * just the sessions' own, grouped into needs you / yours / others, one short
 * line each, and one PR in depth on request. Pure, so it is tested with
 * fixture `gh` JSON.
 */

import type { Session } from "./domain";
import { type ChecksState, type PrInfo, rollupChecks } from "./pr";

/** An open PR as `gh pr list --json <OPEN_PR_FIELDS>` gives it. */
export interface OpenPr {
	number: number;
	url: string;
	title: string;
	author: string | null;
	isDraft: boolean;
	checks: ChecksState;
	/** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null. */
	reviewDecision: string | null;
	/** Logins (users) and slugs (teams) asked to review. */
	reviewRequests: string[];
	headRefName: string;
	/** Last update, ms since the epoch. */
	updatedAt: number;
}

/** The fields the overview asks `gh pr list` for. */
export const OPEN_PR_FIELDS = [
	"number",
	"url",
	"title",
	"author",
	"isDraft",
	"statusCheckRollup",
	"reviewDecision",
	"reviewRequests",
	"headRefName",
	"updatedAt",
].join(",");

/** The most open PRs one overview reads; a busier repo says how many it left out. */
export const OPEN_PR_LIMIT = 50;

/** Lines shown per group; the rest are counted. */
const GROUP_MAX = 10;
const TITLE_MAX = 70;
const BODY_MAX = 1_200;
const FILES_SHOWN = 15;

/** The fields `gh pr view` is asked for when going deeper on one PR. */
export const PR_DETAIL_EXTRA = "body,additions,deletions,headRefName";

/** What a PR's detail has beyond PrInfo. */
export interface PrDetailExtra {
	body: string;
	additions: number;
	deletions: number;
	headRefName: string;
}

function login(raw: unknown): string | null {
	const l = (raw as { login?: unknown } | null)?.login;
	return typeof l === "string" ? l : null;
}

function requests(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return (raw as Array<Record<string, unknown>>)
		.map((q) =>
			typeof q?.login === "string"
				? q.login
				: typeof q?.slug === "string"
					? q.slug
					: null,
		)
		.filter((x): x is string => !!x);
}

/** Parses `gh pr list --json <OPEN_PR_FIELDS>` output, newest updated first. */
export function parseOpenPrs(raw: unknown): OpenPr[] {
	if (!Array.isArray(raw)) return [];
	const out: OpenPr[] = [];
	for (const item of raw as Array<Record<string, unknown>>) {
		if (typeof item?.number !== "number" || typeof item.url !== "string")
			continue;
		const updatedAt =
			typeof item.updatedAt === "string" ? Date.parse(item.updatedAt) : 0;
		out.push({
			number: item.number,
			url: item.url,
			title: typeof item.title === "string" ? item.title : "",
			author: login(item.author),
			isDraft: item.isDraft === true,
			checks: rollupChecks(
				item.statusCheckRollup as Parameters<typeof rollupChecks>[0],
			),
			reviewDecision:
				typeof item.reviewDecision === "string" && item.reviewDecision
					? item.reviewDecision
					: null,
			reviewRequests: requests(item.reviewRequests),
			headRefName: typeof item.headRefName === "string" ? item.headRefName : "",
			updatedAt: Number.isNaN(updatedAt) ? 0 : updatedAt,
		});
	}
	return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Parses the extra fields of `gh pr view --json <PR_FIELDS>,<PR_DETAIL_EXTRA>`. */
export function parsePrDetailExtra(raw: unknown): PrDetailExtra {
	const r = (raw ?? {}) as Record<string, unknown>;
	return {
		body: typeof r.body === "string" ? r.body : "",
		additions: typeof r.additions === "number" ? r.additions : 0,
		deletions: typeof r.deletions === "number" ? r.deletions : 0,
		headRefName: typeof r.headRefName === "string" ? r.headRefName : "",
	};
}

const same = (a: string | null, b: string | null) =>
	!!a && !!b && a.toLowerCase() === b.toLowerCase();

function clip(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const CHECK_WORDS: Record<ChecksState, string> = {
	failing: "checks failing",
	running: "checks running",
	passing: "checks passing",
	none: "no checks",
};

function reviewWords(
	pr: Pick<OpenPr, "reviewDecision" | "reviewRequests">,
	user: string | null,
): string {
	if (pr.reviewDecision === "APPROVED") return "approved";
	if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes requested";
	const asked = pr.reviewRequests.map((r) => (same(r, user) ? "you" : r));
	if (asked.length) return `review requested from ${asked.join(", ")}`;
	return pr.reviewDecision === "REVIEW_REQUIRED"
		? "needs a review, nobody asked"
		: "no review yet";
}

/** The live sessions working on a PR: its stored PR, else its branch. */
export function sessionsFor(
	pr: Pick<OpenPr, "number" | "headRefName">,
	sessions: Session[],
): Session[] {
	const live = sessions.filter((s) => s.status !== "archived");
	const byPr = live.filter((s) => s.pr?.number === pr.number);
	if (byPr.length) return byPr;
	return pr.headRefName
		? live.filter((s) => !s.pr && s.branch === pr.headRefName)
		: [];
}

export interface OverviewInput {
	prs: OpenPr[];
	sessions: Session[];
	/** The logged-in gh user; null if unknown. */
	user: string | null;
	/** PRs GitHub lists as asking the user for a review (teams included). */
	requested: number[];
	/** Whether gh had more open PRs than OPEN_PR_LIMIT. */
	truncated: boolean;
}

interface Row {
	pr: OpenPr;
	line: string;
	group: "needs" | "yours" | "others";
}

/** Why a PR waits on the user, or nothing. */
function waitsOnUser(
	pr: OpenPr,
	mine: boolean,
	owners: Session[],
	user: string | null,
	requested: Set<number>,
): string[] {
	const why: string[] = [];
	if (
		!mine &&
		(requested.has(pr.number) || pr.reviewRequests.some((r) => same(r, user)))
	)
		why.push("your review is requested");
	if (mine && !pr.isDraft) {
		if (pr.reviewDecision === "CHANGES_REQUESTED")
			why.push("address the requested changes");
		if (pr.checks === "failing") why.push("fix the failing checks");
		if (
			pr.reviewDecision === "APPROVED" &&
			(pr.checks === "passing" || pr.checks === "none")
		)
			why.push("approved, ready to merge");
	}
	for (const s of owners)
		if (s.status === "waiting")
			why.push(
				`${s.name} waits on you${s.waitingOn ? ` (${s.waitingOn})` : ""}`,
			);
	return why;
}

function row(input: OverviewInput, requested: Set<number>, pr: OpenPr): Row {
	const owners = sessionsFor(pr, input.sessions);
	const mine = input.user ? same(pr.author, input.user) : owners.length > 0;
	const why = waitsOnUser(pr, mine, owners, input.user, requested);
	const parts = [
		`#${pr.number} "${clip(pr.title, TITLE_MAX)}" by ${mine && input.user ? "you" : (pr.author ?? "unknown")}`,
		owners.length
			? `session ${owners.map((s) => s.name).join(", ")}`
			: "no session",
		...(pr.isDraft ? ["draft"] : []),
		CHECK_WORDS[pr.checks],
		reviewWords(pr, input.user),
		...(why.length ? [`waits on you: ${why.join("; ")}`] : []),
	];
	return {
		pr,
		line: `- ${parts.join(" · ")}`,
		group: why.length ? "needs" : mine ? "yours" : "others",
	};
}

/**
 * The overview the master's pr_overview tool returns: every open PR, one
 * line each, under NEEDS YOU, YOURS and OTHERS. Each group is newest updated
 * first and shows at most GROUP_MAX lines.
 */
export function prOverviewText(input: OverviewInput): string {
	if (!input.prs.length) return "No open PRs in this repo.";
	const requested = new Set(input.requested);
	const rows = input.prs.map((pr) => row(input, requested, pr));
	const groups: Array<[Row["group"], string]> = [
		["needs", "Needs you"],
		["yours", "Yours"],
		["others", "Others"],
	];
	const who = input.user ? `you are ${input.user}` : "gh user unknown";
	const lines = [
		`Open PRs: ${input.prs.length}${input.truncated ? "+" : ""} (${who}).`,
	];
	for (const [key, title] of groups) {
		const in_ = rows.filter((r) => r.group === key);
		if (!in_.length) {
			lines.push(`${title}: none.`);
			continue;
		}
		lines.push(`${title} (${in_.length}):`);
		lines.push(...in_.slice(0, GROUP_MAX).map((r) => r.line));
		if (in_.length > GROUP_MAX)
			lines.push(`- and ${in_.length - GROUP_MAX} more`);
	}
	if (input.truncated)
		lines.push(
			`Only the ${OPEN_PR_LIMIT} most recently updated open PRs were read.`,
		);
	lines.push(
		"Answer with this grouped, one short line per PR; leave out empty groups. For one PR in depth, call pr_overview with pr set to its number.",
	);
	return lines.join("\n");
}

/** One PR in depth, for "what does #123 change?". */
export function prDetailText(opts: {
	pr: PrInfo;
	extra: PrDetailExtra;
	sessions: Session[];
	user: string | null;
}): string {
	const { pr, extra, user } = opts;
	const owners = sessionsFor(
		{ number: pr.number, headRefName: extra.headRefName },
		opts.sessions,
	);
	const state =
		pr.state === "OPEN"
			? pr.isDraft
				? "draft"
				: "open"
			: pr.state.toLowerCase();
	const words = reviewWords(pr, user);
	// Asked but nobody has looked yet is worth saying; "no review yet" says it already.
	const review =
		pr.reviewed || words === "no review yet"
			? words
			: `${words}, nobody has reviewed yet`;
	const lines = [
		`#${pr.number} "${pr.title}" by ${same(pr.author, user) ? "you" : (pr.author ?? "unknown")} · ${state} · ${extra.headRefName || "?"} → ${pr.baseRefName || "?"}`,
		`${owners.length ? `session ${owners.map((s) => s.name).join(", ")}` : "no session"} · ${CHECK_WORDS[pr.checks]} · ${review}`,
		`${pr.url}`,
	];
	const shown = pr.files.slice(0, FILES_SHOWN);
	lines.push(
		`+${extra.additions} −${extra.deletions} in ${pr.files.length} file${pr.files.length === 1 ? "" : "s"}${shown.length ? `: ${shown.join(", ")}${pr.files.length > shown.length ? `, and ${pr.files.length - shown.length} more` : ""}` : ""}`,
	);
	const body = clip(extra.body, BODY_MAX);
	lines.push(body ? `Description: ${body}` : "No description.");
	lines.push(
		`For the code itself, gh pr diff ${pr.number}. Answer in a few sentences: what it changes and what it waits on.`,
	);
	return lines.join("\n");
}

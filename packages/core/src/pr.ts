/**
 * Pull request status from `gh pr view --json` (ADR 0011), reduced to what a
 * card shows and what the master needs. Pure, so it is tested with fixtures.
 */

import type { Session } from "./domain";

export type ChecksState = "failing" | "running" | "passing" | "none";

export interface PrInfo {
	number: number;
	url: string;
	title: string;
	state: "OPEN" | "CLOSED" | "MERGED";
	isDraft: boolean;
	checks: ChecksState;
	/** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null. */
	reviewDecision: string | null;
	/** Logins (users) and org/slug (teams) asked to review. */
	reviewRequests: string[];
	/** Whether anyone has reviewed yet. */
	reviewed: boolean;
	author: string | null;
	/** The PR's head commit; compared to the local branch before deleting it. */
	headRefOid: string;
	baseRefName: string;
	files: string[];
}

/** The fields serenity asks gh for. */
export const PR_FIELDS = [
	"number",
	"url",
	"title",
	"state",
	"isDraft",
	"statusCheckRollup",
	"reviewDecision",
	"reviewRequests",
	"latestReviews",
	"author",
	"headRefOid",
	"baseRefName",
	"files",
].join(",");

interface CheckEntry {
	__typename?: string;
	status?: string | null;
	conclusion?: string | null;
	state?: string | null;
}

const FAILED = new Set([
	"FAILURE",
	"TIMED_OUT",
	"CANCELLED",
	"ACTION_REQUIRED",
	"STARTUP_FAILURE",
	"ERROR",
]);
const PENDING = new Set([
	"PENDING",
	"EXPECTED",
	"QUEUED",
	"IN_PROGRESS",
	"WAITING",
	"REQUESTED",
]);

/** Any failure wins, then anything still running, then passing. */
export function rollupChecks(
	entries: CheckEntry[] | null | undefined,
): ChecksState {
	if (!entries?.length) return "none";
	let running = false;
	for (const e of entries) {
		const outcome = e.conclusion ?? e.state ?? null;
		if (outcome && FAILED.has(outcome)) return "failing";
		const done =
			e.__typename === "StatusContext"
				? !PENDING.has(e.state ?? "")
				: e.status === "COMPLETED";
		if (!done || (outcome && PENDING.has(outcome))) running = true;
	}
	return running ? "running" : "passing";
}

/** Parses `gh pr view --json <PR_FIELDS>` output; null if it is not a PR. */
export function parsePr(raw: unknown): PrInfo | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.number !== "number" || typeof r.url !== "string") return null;
	const state = r.state === "MERGED" || r.state === "CLOSED" ? r.state : "OPEN";
	const requests = Array.isArray(r.reviewRequests)
		? (r.reviewRequests as Array<Record<string, unknown>>)
				.map((q) =>
					typeof q.login === "string"
						? q.login
						: typeof q.slug === "string"
							? q.slug
							: null,
				)
				.filter((x): x is string => !!x)
		: [];
	const files = Array.isArray(r.files)
		? (r.files as Array<{ path?: unknown }>)
				.map((f) => f.path)
				.filter((p): p is string => typeof p === "string")
		: [];
	const author = (r.author as { login?: unknown } | null)?.login;
	return {
		number: r.number,
		url: r.url,
		title: typeof r.title === "string" ? r.title : "",
		state,
		isDraft: r.isDraft === true,
		checks: rollupChecks(r.statusCheckRollup as CheckEntry[] | null),
		reviewDecision:
			typeof r.reviewDecision === "string" && r.reviewDecision
				? r.reviewDecision
				: null,
		reviewRequests: requests,
		reviewed: Array.isArray(r.latestReviews) && r.latestReviews.length > 0,
		author: typeof author === "string" ? author : null,
		headRefOid: typeof r.headRefOid === "string" ? r.headRefOid : "",
		baseRefName: typeof r.baseRefName === "string" ? r.baseRefName : "",
		files,
	};
}

// ------------------------------------------------- finding a session's PR

/** What git knows about a local branch, for finding its PR (ADR 0055). */
export interface BranchFacts {
	name: string;
	/** The remote branch it tracks, e.g. "fix/x" for origin/fix/x; null if none. */
	upstream: string | null;
	/** The remote it tracks, e.g. "origin"; null if none. */
	remote: string | null;
}

/**
 * Whether `upstream` is the branch's own push target under another prefix
 * (X pushed as fix/X, docs/X → X) rather than the branch it started from: a
 * new worktree's branch tracks origin/main, whose PRs are not the session's.
 */
function sameWork(name: string, upstream: string): boolean {
	return (
		name === upstream ||
		upstream.endsWith(`/${name}`) ||
		name.endsWith(`/${upstream}`)
	);
}

/**
 * The heads to ask gh about, most likely first (ADR 0055): each branch's
 * upstream when it is the same work under another name, then the branch
 * itself, never the base. With more than one remote (a fork), each is
 * repeated as `owner:branch`, which is how gh finds a PR from a fork.
 */
export function prHeads(opts: {
	/** The worktree's current branch first, then the session's own. */
	branches: BranchFacts[];
	base: string | null;
	/** Remote name → GitHub owner; only consulted with more than one remote. */
	owners: Record<string, string>;
}): string[] {
	const plain: string[] = [];
	const forked: string[] = [];
	const fork = Object.keys(opts.owners).length > 1;
	const add = (head: string, remote: string | null) => {
		if (!head || head === "HEAD" || head === opts.base) return;
		if (!plain.includes(head)) plain.push(head);
		const owner = fork && remote ? opts.owners[remote] : undefined;
		const qualified = owner ? `${owner}:${head}` : null;
		if (qualified && !forked.includes(qualified)) forked.push(qualified);
	};
	for (const b of opts.branches) {
		const pushed =
			b.upstream && sameWork(b.name, b.upstream) ? b.upstream : null;
		// Only the name it was pushed as exists on the fork.
		if (pushed) add(pushed, b.remote);
		add(b.name, pushed ? null : b.remote);
	}
	return [...plain, ...forked];
}

/** The GitHub owner in a remote URL (https or ssh); null if not GitHub-shaped. */
export function remoteOwner(url: string): string | null {
	const remote =
		/^(?:[a-z+]+:\/\/(?:[^@/]+@)?[^/]+\/|[^@/:]+@[^:/]+:)([^/]+)\/[^/]+?\/?$/i;
	return url.trim().match(remote)?.[1] ?? null;
}

/** A PostToolUse that may have opened, pushed or merged a PR (ADR 0055). */
export function touchesPr(payload: {
	tool_name?: string;
	[key: string]: unknown;
}): boolean {
	if (payload.tool_name !== "Bash") return false;
	const command = (payload.tool_input as { command?: unknown } | undefined)
		?.command;
	return (
		typeof command === "string" &&
		/\bgit\s+(?:-\S+\s+\S+\s+)*push\b|\bgh\s+pr\s+(?:create|merge|ready|close|reopen|edit)\b/.test(
			command,
		)
	);
}

export type PrTone = "merged" | "good" | "bad" | "warn" | "quiet";

/** "PR #74": drawn in PR_LABEL_COLOR wherever a session's PR shows. */
export function prLabel(pr: Pick<PrInfo, "number">): string {
	return `PR #${pr.number}`;
}

/** The word on the card (design: words only, never a glyph). */
export function prStatus(pr: PrInfo): { text: string; tone: PrTone } {
	if (pr.state === "MERGED") return { text: "merged", tone: "merged" };
	if (pr.state === "CLOSED") return { text: "closed", tone: "quiet" };
	if (pr.isDraft) return { text: "draft", tone: "quiet" };
	if (pr.checks === "failing") return { text: "checks failing", tone: "bad" };
	if (pr.reviewDecision === "CHANGES_REQUESTED")
		return { text: "changes requested", tone: "warn" };
	if (pr.checks === "running") return { text: "checks running", tone: "quiet" };
	if (pr.reviewDecision === "APPROVED")
		return { text: "approved", tone: "good" };
	if (pr.checks === "passing") return { text: "checks passing", tone: "good" };
	return { text: "open", tone: "quiet" };
}

/**
 * A PR is ready for a reviewer when it is open, not a draft, its checks are
 * not failing or running, and nobody has been asked or has reviewed yet.
 */
export function wantsReviewer(pr: PrInfo): boolean {
	return (
		pr.state === "OPEN" &&
		!pr.isDraft &&
		(pr.checks === "passing" || pr.checks === "none") &&
		pr.reviewDecision !== "APPROVED" &&
		pr.reviewRequests.length === 0 &&
		!pr.reviewed
	);
}

// ------------------------------------------------------- the master's GitHub

/** An open PR in the repo that asks the user for a review (ADR 0011). */
export interface ReviewRequest {
	number: number;
	url: string;
	title: string;
	author: string | null;
	/** Last update, ms since the epoch. */
	updatedAt: number;
}

/** What the master panel shows from GitHub beyond the sessions' own PRs. */
export interface GithubState {
	/** The logged-in gh user; null until known. */
	user: string | null;
	/** Newest updated first, at most REVIEW_LIMIT. */
	reviewRequests: ReviewRequest[];
}

export const REVIEW_LIMIT = 3;

/** The fields serenity asks `gh pr list` for. */
export const REVIEW_FIELDS = "number,url,title,author,updatedAt";

/** Parses `gh pr list --json <REVIEW_FIELDS>` output, newest updated first. */
export function parseReviewRequests(raw: unknown): ReviewRequest[] {
	if (!Array.isArray(raw)) return [];
	const out: ReviewRequest[] = [];
	for (const item of raw as Array<Record<string, unknown>>) {
		if (typeof item?.number !== "number" || typeof item.url !== "string")
			continue;
		const author = (item.author as { login?: unknown } | null)?.login;
		const updatedAt =
			typeof item.updatedAt === "string" ? Date.parse(item.updatedAt) : 0;
		out.push({
			number: item.number,
			url: item.url,
			title: typeof item.title === "string" ? item.title : "",
			author: typeof author === "string" ? author : null,
			updatedAt: Number.isNaN(updatedAt) ? 0 : updatedAt,
		});
	}
	return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, REVIEW_LIMIT);
}

/**
 * The user's open PRs from sessions on the map, one row per PR (imported
 * sessions can share a branch), newest first. Archived sessions are left out:
 * their PRs are no longer refreshed. Without a known user, every PR counts.
 */
export function myPullRequests(
	sessions: Session[],
	user: string | null,
): Array<{ session: Session; pr: PrInfo }> {
	const seen = new Set<number>();
	const out: Array<{ session: Session; pr: PrInfo }> = [];
	for (const session of sessions) {
		const pr = session.pr;
		if (pr?.state !== "OPEN" || session.status === "archived") continue;
		if (user && pr.author && pr.author.toLowerCase() !== user.toLowerCase())
			continue;
		if (seen.has(pr.number)) continue;
		seen.add(pr.number);
		out.push({ session, pr });
	}
	return out.sort((a, b) => b.pr.number - a.pr.number);
}

// ---------------------------------------------------------------- CODEOWNERS

/** Where GitHub looks for CODEOWNERS, in its order. */
export const CODEOWNERS_PATHS = [
	".github/CODEOWNERS",
	"CODEOWNERS",
	"docs/CODEOWNERS",
];

interface OwnerRule {
	pattern: string;
	owners: string[];
}

export function parseCodeowners(text: string): OwnerRule[] {
	const rules: OwnerRule[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.replace(/#.*$/, "").trim();
		if (!line) continue;
		const [pattern, ...owners] = line.split(/\s+/);
		if (!pattern) continue;
		rules.push({
			pattern,
			owners: owners.filter((o) => o.startsWith("@")).map((o) => o.slice(1)),
		});
	}
	return rules;
}

/** Converts a CODEOWNERS (gitignore-style) pattern to globs over repo paths. */
function patternGlobs(pattern: string): string[] {
	let p = pattern;
	const anchored = p.startsWith("/");
	if (anchored) p = p.slice(1);
	if (p.endsWith("/")) p = `${p}**`;
	const floating = !anchored && !p.slice(0, -1).includes("/");
	const base = floating ? `**/${p}` : p;
	// A pattern can name a file or a directory; the second glob covers directories.
	return [base, `${base}/**`];
}

function matches(pattern: string, path: string): boolean {
	if (pattern === "*") return true;
	return patternGlobs(pattern).some((glob) => new Bun.Glob(glob).match(path));
}

/** Owners of the changed files: for each file the last matching rule wins. */
export function ownersFor(rules: OwnerRule[], files: string[]): string[] {
	const owners: string[] = [];
	for (const file of files) {
		const rule = [...rules].reverse().find((r) => matches(r.pattern, file));
		for (const owner of rule?.owners ?? [])
			if (!owners.includes(owner)) owners.push(owner);
	}
	return owners;
}

/**
 * Reviewer candidates (ADR 0011): CODEOWNERS of the changed files, then the
 * config list, minus the author, the current user and anyone already asked.
 */
export function reviewerCandidates(opts: {
	codeowners: string[];
	configured: string[];
	exclude: Array<string | null>;
}): string[] {
	const skip = new Set(
		opts.exclude.filter(Boolean).map((x) => (x as string).toLowerCase()),
	);
	const out: string[] = [];
	for (const login of [...opts.codeowners, ...opts.configured]) {
		const clean = login.replace(/^@/, "");
		if (!clean || skip.has(clean.toLowerCase()) || out.includes(clean))
			continue;
		out.push(clean);
	}
	return out;
}

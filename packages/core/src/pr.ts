/**
 * Pull request status from `gh pr view --json` (ADR 0011), reduced to what a
 * card shows and what the master needs. Pure, so it is tested with fixtures.
 */

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

export type PrTone = "merged" | "good" | "bad" | "warn" | "quiet";

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

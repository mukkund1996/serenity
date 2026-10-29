import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CODEOWNERS_PATHS,
	isTransientMessage,
	PR_FIELDS,
	type PrInfo,
	parsePr,
	parseReviewRequests,
	REVIEW_FIELDS,
	REVIEW_LIMIT,
	type ReviewRequest,
	withRetry,
} from "@serenity/core";
import { reportDependency } from "./exec";

/** What reading a branch's PR gave: the PR, or why it could not be read. */
export interface PrLookup {
	pr: PrInfo | null;
	/** Shown on the card: gh missing, not logged in. Null for "no PR". */
	error: string | null;
}

const TIMEOUT_MS = 20_000;

interface Output {
	ok: boolean;
	stdout: string;
	stderr: string;
}

/**
 * Thin `gh` driver (ADR 0011). SERENITY_GH_BIN points it at the E2E fake.
 */
export class Gh {
	private me: Promise<string | null> | null = null;

	constructor(
		private readonly bin: string = process.env.SERENITY_GH_BIN ?? "gh",
	) {}

	private async run(args: string[], cwd: string): Promise<Output> {
		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn([this.bin, ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
				env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
			});
		} catch {
			return { ok: false, stdout: "", stderr: "gh: command not found" };
		}
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, TIMEOUT_MS);
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout as ReadableStream).text(),
			new Response(proc.stderr as ReadableStream).text(),
			proc.exited,
		]);
		clearTimeout(timer);
		if (timedOut) return { ok: false, stdout, stderr: "gh timed out" };
		return { ok: code === 0, stdout, stderr };
	}

	/**
	 * A read: retried while gh fails in a way that may pass (ADR 0043), and
	 * reported to the dependency health.
	 */
	private async read(args: string[], cwd: string): Promise<Output> {
		const out = await withRetry(
			async () => {
				const out = await this.run(args, cwd);
				if (!out.ok && isTransientMessage(out.stderr))
					throw new TransientGh(out);
				return out;
			},
			{ isTransient: (e) => e instanceof TransientGh },
		).catch((e: unknown) => {
			if (e instanceof TransientGh) return e.out;
			throw e;
		});
		const problem = healthOf(out);
		if (problem !== undefined) reportDependency("gh", problem);
		return out;
	}

	async prForBranch(cwd: string, branch: string): Promise<PrLookup> {
		const out = await this.read(
			["pr", "view", branch, "--json", PR_FIELDS],
			cwd,
		);
		if (out.ok) {
			try {
				return { pr: parsePr(JSON.parse(out.stdout)), error: null };
			} catch {
				return { pr: null, error: "unreadable gh output" };
			}
		}
		return { pr: null, error: classifyGhError(out.stderr) };
	}

	/** Open PRs in the repo asking the user for a review, newest updated first. */
	async reviewRequests(
		cwd: string,
	): Promise<{ prs: ReviewRequest[]; error: string | null }> {
		const out = await this.read(
			[
				"pr",
				"list",
				"--search",
				"review-requested:@me sort:updated-desc",
				"--state",
				"open",
				"--limit",
				String(REVIEW_LIMIT),
				"--json",
				REVIEW_FIELDS,
			],
			cwd,
		);
		if (!out.ok) return { prs: [], error: classifyGhError(out.stderr) };
		try {
			return { prs: parseReviewRequests(JSON.parse(out.stdout)), error: null };
		} catch {
			return { prs: [], error: "unreadable gh output" };
		}
	}

	/** The logged-in GitHub user, asked until gh answers. */
	currentUser(cwd: string): Promise<string | null> {
		this.me ??= this.read(["api", "user", "--jq", ".login"], cwd).then(
			(out) => {
				const login = out.ok ? out.stdout.trim() || null : null;
				// A failure is asked again next time rather than kept for good.
				if (!login) this.me = null;
				return login;
			},
		);
		return this.me;
	}

	async requestReview(
		cwd: string,
		pr: number,
		reviewer: string,
	): Promise<void> {
		const out = await this.run(
			["pr", "edit", String(pr), "--add-reviewer", reviewer],
			cwd,
		);
		if (!out.ok)
			throw new Error(
				`gh could not request ${reviewer}: ${firstLine(out.stderr)}`,
			);
	}
}

class TransientGh extends Error {
	constructor(readonly out: Output) {
		super(out.stderr);
	}
}

/**
 * What a read says about gh itself. A missing PR or remote is gh answering;
 * an error that is neither about gh nor transient says nothing either way.
 */
function healthOf(out: Output): string | null | undefined {
	if (out.ok) return null;
	const reason = classifyGhError(out.stderr);
	if (reason === null) return null;
	if (reason === "gh not installed" || reason === "gh not logged in")
		return reason;
	if (isTransientMessage(out.stderr)) return "gh unreachable";
	return undefined;
}

function firstLine(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * Null for the quiet cases (no PR yet, not a GitHub repo); otherwise a short
 * reason for the card.
 */
export function classifyGhError(stderr: string): string | null {
	if (/no pull requests found/i.test(stderr)) return null;
	if (
		/none of the git remotes|no git remotes|not a git repository/i.test(stderr)
	)
		return null;
	if (/command not found|ENOENT/i.test(stderr)) return "gh not installed";
	if (/gh auth login|not logged|authentication/i.test(stderr))
		return "gh not logged in";
	return firstLine(stderr) || "gh failed";
}

/** The repo's CODEOWNERS text, from the first place GitHub looks. */
export function readCodeowners(dir: string): string | null {
	for (const path of CODEOWNERS_PATHS) {
		const full = join(dir, path);
		if (existsSync(full)) return readFileSync(full, "utf8");
	}
	return null;
}

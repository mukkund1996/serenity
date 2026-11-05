import {
	type MasterToolResult,
	type OpenPr,
	prDetailText,
	prOverviewText,
	type ReviewRequest,
	type Storage,
} from "@serenity/core";
import type { Gh } from "./gh";

export interface PrOverviewHost {
	storage: Storage;
	gh: Gh;
	/** Review requests the ReviewWatcher already has for the repo (teams included). */
	reviewRequests(repo: string): ReviewRequest[];
	now(): number;
}

/** An overview asked again within this long reuses the last read. */
export const OVERVIEW_CACHE_MS = 30_000;

interface Cached {
	prs: OpenPr[];
	truncated: boolean;
	at: number;
}

/**
 * The master's `pr_overview` tool (ADR 0061): the repo's open PRs from one
 * `gh pr list`, cached briefly, joined with the sessions on the map and the
 * review requests serenity already polls. With a PR number, that PR in depth.
 */
export class PrOverview {
	private readonly cache = new Map<string, Cached>();

	constructor(private readonly host: PrOverviewHost) {}

	async answer(repo: string, pr: number | null): Promise<MasterToolResult> {
		return pr === null ? this.overview(repo) : this.detail(repo, pr);
	}

	private async overview(repo: string): Promise<MasterToolResult> {
		const now = this.host.now();
		let cached = this.cache.get(repo);
		let stale: string | null = null;
		if (!cached || now - cached.at >= OVERVIEW_CACHE_MS) {
			const lookup = await this.host.gh.openPrs(repo);
			if (lookup.error) {
				if (!cached) return failure(lookup.error, "the open PRs");
				// A failed read keeps the last list, said to be old.
				stale = `From ${Math.round((now - cached.at) / 60_000)} min ago; gh failed just now: ${lookup.error}.`;
			} else {
				cached = { prs: lookup.prs, truncated: lookup.truncated, at: now };
				this.cache.set(repo, cached);
			}
		}
		const user = await this.host.gh.currentUser(repo);
		const text = prOverviewText({
			prs: cached.prs,
			sessions: this.host.storage.sessions.listByRepo(repo),
			user,
			requested: this.host.reviewRequests(repo).map((r) => r.number),
			truncated: cached.truncated,
		});
		return { text: stale ? `${stale}\n${text}` : text };
	}

	private async detail(
		repo: string,
		number: number,
	): Promise<MasterToolResult> {
		const [lookup, user] = await Promise.all([
			this.host.gh.prDetail(repo, number),
			this.host.gh.currentUser(repo),
		]);
		if (lookup.error || !lookup.pr || !lookup.extra)
			return failure(lookup.error ?? "unreadable gh output", `PR #${number}`);
		return {
			text: prDetailText({
				pr: lookup.pr,
				extra: lookup.extra,
				sessions: this.host.storage.sessions.listByRepo(repo),
				user,
			}),
		};
	}
}

function failure(error: string, what: string): MasterToolResult {
	if (error === "gh not logged in")
		return {
			text: `gh is not logged in, so serenity cannot read ${what}. Tell the user to run gh auth login in a terminal.`,
			isError: true,
		};
	if (error === "gh not installed")
		return {
			text: `gh is not installed, so serenity cannot read ${what}. Tell the user to install the GitHub CLI and run gh auth login.`,
			isError: true,
		};
	return { text: `Could not read ${what}: ${error}.`, isError: true };
}

/** The tool's `pr` argument: 123, "123" or "#123"; null when left out. */
export function prArg(raw: unknown): number | null | "invalid" {
	if (raw === undefined || raw === null || raw === "") return null;
	const n =
		typeof raw === "number"
			? raw
			: Number(String(raw).trim().replace(/^#/, ""));
	return Number.isInteger(n) && n > 0 ? n : "invalid";
}

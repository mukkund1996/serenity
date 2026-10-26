import type { GithubState } from "@serenity/core";
import type { Gh } from "./gh";

export interface ReviewHost {
	gh: Gh;
	/** Whether any map of the repo is open; polling stops when none is. */
	watching(repo: string): boolean;
	broadcast(repo: string): void;
	log(line: string): void;
	pollMs: number;
}

/** Opening a map refreshes review requests at most this often. */
const OPEN_REFRESH_MS = 60_000;

interface Entry {
	state: GithubState;
	at: number;
	timer: ReturnType<typeof setInterval> | null;
	inflight: boolean;
}

/**
 * Review requests for the master panel (ADR 0011). Nothing in serenity fires
 * when someone asks the user for a review, so unlike session PRs these are
 * polled: on opening a map, then every `pollMs` while a map of the repo is open.
 */
export class ReviewWatcher {
	private readonly repos = new Map<string, Entry>();

	constructor(private readonly host: ReviewHost) {}

	state(repo: string): GithubState {
		return this.repos.get(repo)?.state ?? { user: null, reviewRequests: [] };
	}

	/** A map of the repo opened. */
	watch(repo: string, now = Date.now()): void {
		let entry = this.repos.get(repo);
		if (!entry) {
			entry = {
				state: this.state(repo),
				at: 0,
				timer: null,
				inflight: false,
			};
			this.repos.set(repo, entry);
		}
		if (!entry.timer) {
			const owner = entry;
			owner.timer = setInterval(() => {
				if (this.host.watching(repo)) return void this.refresh(repo);
				clearInterval(owner.timer ?? undefined);
				owner.timer = null;
			}, this.host.pollMs);
		}
		if (now - entry.at >= OPEN_REFRESH_MS) void this.refresh(repo);
	}

	async refresh(repo: string): Promise<void> {
		const entry = this.repos.get(repo);
		if (!entry || entry.inflight) return;
		entry.inflight = true;
		try {
			const [user, lookup] = await Promise.all([
				this.host.gh.currentUser(repo),
				this.host.gh.reviewRequests(repo),
			]);
			entry.at = Date.now();
			// A failed call keeps the last list rather than blanking the panel.
			if (lookup.error) this.host.log(`review requests: ${lookup.error}`);
			const next: GithubState = {
				user,
				reviewRequests: lookup.error ? entry.state.reviewRequests : lookup.prs,
			};
			if (JSON.stringify(next) === JSON.stringify(entry.state)) return;
			entry.state = next;
			this.host.broadcast(repo);
		} catch (error) {
			this.host.log(`review requests for ${repo} failed: ${String(error)}`);
		} finally {
			entry.inflight = false;
		}
	}

	stop(): void {
		for (const entry of this.repos.values())
			if (entry.timer) clearInterval(entry.timer);
		this.repos.clear();
	}
}

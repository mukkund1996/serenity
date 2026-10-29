import { existsSync } from "node:fs";
import {
	ownersFor,
	parseCodeowners,
	reviewerCandidates,
	type Session,
	type Storage,
	type SuggestionKind,
	wantsReviewer,
} from "@serenity/core";
import { type Gh, readCodeowners } from "./gh";

export interface PrHost {
	storage: Storage;
	gh: Gh;
	/** Fallback reviewers from config when CODEOWNERS names nobody. */
	reviewers: string[];
	/** Saves a patch and lets the master react (a merged PR makes it done). */
	change(session: Session, patch: Partial<Session>): Session;
	broadcast(repo: string): void;
	propose(
		session: Session,
		kind: SuggestionKind,
		label: string,
		text: string | null,
		source: "worker",
	): void;
	log(line: string): void;
	debounceMs: number;
}

/** Opening a map refreshes each session's PR at most this often. */
const REPO_REFRESH_MS = 60_000;
/** Offers remembered; the oldest are long merged. */
const OFFERED_KEPT = 500;

/**
 * Keeps each session's PR current from gh (ADR 0011): on events only, no
 * polling. A merged PR makes the session finished; a ready PR that nobody
 * reviews yet gets a review-request suggestion, reviewer from CODEOWNERS or
 * the config.
 */
export class PrWatcher {
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly inflight = new Set<string>();
	private readonly lastRefresh = new Map<string, number>();
	/** session:pr pairs already offered a reviewer, so a decline sticks; stored, so it sticks across restarts too. */
	private readonly offered: Set<string>;

	constructor(private readonly host: PrHost) {
		this.offered = new Set(host.storage.recovery.get("offeredReviews") ?? []);
	}

	schedule(sessionId: string, delayMs = this.host.debounceMs): void {
		clearTimeout(this.timers.get(sessionId));
		this.timers.set(
			sessionId,
			setTimeout(() => {
				this.timers.delete(sessionId);
				void this.refresh(sessionId);
			}, delayMs),
		);
	}

	/** When a map opens: refresh sessions not refreshed in the last minute. */
	refreshRepo(repo: string, now = Date.now()): void {
		for (const s of this.host.storage.sessions.listByRepo(repo)) {
			if (!s.branch || s.status === "archived") continue;
			if (now - (this.lastRefresh.get(s.id) ?? 0) < REPO_REFRESH_MS) continue;
			this.schedule(s.id, 0);
		}
	}

	async refresh(sessionId: string): Promise<void> {
		const session = this.host.storage.sessions.get(sessionId);
		if (!session?.branch || session.status === "archived") return;
		if (this.inflight.has(sessionId)) return this.schedule(sessionId);
		this.inflight.add(sessionId);
		try {
			const lookup = await this.host.gh.prForBranch(
				workDir(session),
				session.branch,
			);
			this.lastRefresh.set(sessionId, Date.now());
			const fresh = this.host.storage.sessions.get(sessionId);
			if (!fresh || fresh.status === "archived") return;
			const patch: Partial<Session> = { pr: lookup.pr, prError: lookup.error };
			// Imported sessions often share a checkout, so its PR is not theirs
			// alone; a pinned one is kept for the next task (ADR 0022).
			if (
				lookup.pr?.state === "MERGED" &&
				fresh.status === "idle" &&
				fresh.origin === "spawned" &&
				!fresh.pinned
			)
				patch.status = "done";
			const changed =
				JSON.stringify([fresh.pr, fresh.prError, fresh.status]) !==
				JSON.stringify([patch.pr, patch.prError, patch.status ?? fresh.status]);
			const after = changed ? this.host.change(fresh, patch) : fresh;
			if (changed) this.host.broadcast(fresh.repo);
			await this.offerReviewer(after);
		} catch (error) {
			this.host.log(`PR refresh for ${session.name} failed: ${String(error)}`);
		} finally {
			this.inflight.delete(sessionId);
		}
	}

	private async offerReviewer(session: Session): Promise<void> {
		const pr = session.pr;
		if (!pr || !wantsReviewer(pr)) return;
		if (session.status !== "idle" && session.status !== "done") return;
		const pending = this.host.storage.suggestions
			.listPending(session.repo)
			.some((g) => g.sessionId === session.id);
		const key = `${session.id}:${pr.number}`;
		if (pending || this.offered.has(key)) return;

		const dir = workDir(session);
		const codeowners = readCodeowners(dir);
		const owners = codeowners
			? ownersFor(parseCodeowners(codeowners), pr.files)
			: [];
		const me = await this.host.gh.currentUser(dir);
		const [reviewer] = reviewerCandidates({
			codeowners: owners,
			configured: this.host.reviewers,
			exclude: [pr.author, me],
		});
		if (!reviewer) return;
		this.offered.add(key);
		this.host.storage.recovery.set(
			"offeredReviews",
			[...this.offered].slice(-OFFERED_KEPT),
		);
		this.host.propose(
			session,
			"review",
			`Request review from @${reviewer}`,
			reviewer,
			"worker",
		);
	}

	stop(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}
}

/** Where gh and CODEOWNERS are read: the worktree, else the repo. */
export function workDir(session: Session): string {
	return session.worktree && existsSync(session.worktree)
		? session.worktree
		: session.repo;
}

import { existsSync } from "node:fs";
import {
	type Backoff,
	type BranchFacts,
	backoffMs,
	isTransientMessage,
	ownersFor,
	type PrInfo,
	parseCodeowners,
	prHeads,
	reviewerCandidates,
	type Session,
	type Storage,
	type SuggestionKind,
	wantsReviewer,
} from "@serenity/core";
import { type Gh, type PrLookup, RATE_LIMITED, readCodeowners } from "./gh";
import {
	branchFacts,
	checkedOutBranch,
	defaultBase,
	remoteOwners,
} from "./git";

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
	/** Between reads again after gh failed for a while; defaults to PR_RETRY. */
	retryBackoff?: Backoff;
	/** After GitHub rate limits gh; defaults to PR_RATE_LIMITED. */
	rateLimitBackoff?: Backoff;
	/** The heads to ask gh about, most likely first; defaults to resolveHeads. */
	heads?(session: Session): Promise<string[]>;
	/** Whether a map of the repo is open; open PRs are polled only then. */
	watching?(repo: string): boolean;
	/** How often open PRs are polled while a map is open; 0 turns it off. */
	pollMs?: number;
}

/** Opening a map refreshes each session's PR at most this often. */
const REPO_REFRESH_MS = 60_000;
/** Offers remembered; the oldest are long merged. */
const OFFERED_KEPT = 500;

/**
 * After gh fails transiently, even with its own retries, the PR is read
 * again this many times, further apart each time, so a card does not stay
 * stale until the next event (ADR 0043).
 */
const PR_RETRIES = 5;
const PR_RETRY: Backoff = { baseMs: 5_000, maxMs: 60_000 };
/** A rate limit lasts minutes, so reads wait longer (ADR 0055). */
const PR_RATE_LIMITED: Backoff = { baseMs: 60_000, maxMs: 10 * 60_000 };
/** An open PR whose checks have finished is polled every this many ticks. */
const SETTLED_TICKS = 3;

/**
 * Keeps each session's PR current from gh (ADR 0011, 0055): on events, and
 * for open PRs on a timer while a map is open. A known PR is never dropped
 * because gh failed. A merged PR makes the session finished; a ready PR that
 * nobody reviews yet gets a review-request suggestion, reviewer from
 * CODEOWNERS or the config.
 */
export class PrWatcher {
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly inflight = new Set<string>();
	private readonly lastRefresh = new Map<string, number>();
	/** session:pr pairs already offered a reviewer, so a decline sticks; stored, so it sticks across restarts too. */
	private readonly offered: Set<string>;
	/** session id → reads again so far after transient gh failures. */
	private readonly retries = new Map<string, number>();
	/** repo → its poll timer, while a map of it is open. */
	private readonly polls = new Map<string, ReturnType<typeof setInterval>>();
	private ticks = 0;
	/** No polling before this, after GitHub rate limited a read. */
	private pausedUntil = 0;

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

	/**
	 * A map of the repo opened: open PRs are read again every `pollMs`
	 * (every SETTLED_TICKS × that once their checks are done) until no map
	 * of the repo is open. Merged, closed and missing PRs wait for events.
	 */
	watch(repo: string): void {
		const pollMs = this.host.pollMs ?? 0;
		if (pollMs <= 0 || this.polls.has(repo)) return;
		const timer = setInterval(() => {
			if (!(this.host.watching?.(repo) ?? false)) {
				clearInterval(timer);
				this.polls.delete(repo);
				return;
			}
			this.poll(repo);
		}, pollMs);
		this.polls.set(repo, timer);
	}

	/** One poll tick: schedules the open PRs that are due. */
	poll(repo: string, now = Date.now()): void {
		this.ticks++;
		if (now < this.pausedUntil) return;
		for (const s of this.host.storage.sessions.listByRepo(repo)) {
			if (s.status === "archived" || s.pr?.state !== "OPEN") continue;
			if (s.pr.checks !== "running" && this.ticks % SETTLED_TICKS !== 0)
				continue;
			if (!this.timers.has(s.id)) this.schedule(s.id, 0);
		}
	}

	async refresh(sessionId: string): Promise<void> {
		const session = this.host.storage.sessions.get(sessionId);
		if (!session?.branch || session.status === "archived") return;
		if (this.inflight.has(sessionId)) return this.schedule(sessionId);
		this.inflight.add(sessionId);
		try {
			const lookup = await this.lookup(session);
			this.lastRefresh.set(sessionId, Date.now());
			const fresh = this.host.storage.sessions.get(sessionId);
			if (!fresh || fresh.status === "archived") return;
			const limited = lookup.error === RATE_LIMITED;
			const passing =
				limited || (!!lookup.error && isTransientMessage(lookup.error));
			if (limited)
				this.pausedUntil =
					Date.now() + (this.host.rateLimitBackoff ?? PR_RATE_LIMITED).baseMs;
			// No failure, passing or lasting, blanks a PR already known (ADR 0055).
			const patch: Partial<Session> = {
				pr: lookup.error ? fresh.pr : lookup.pr,
				prError: lookup.error,
			};
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
			if (passing) this.retryLater(fresh, limited);
			else this.retries.delete(sessionId);
			await this.offerReviewer(after);
		} catch (error) {
			this.host.log(`PR refresh for ${session.name} failed: ${String(error)}`);
		} finally {
			this.inflight.delete(sessionId);
		}
	}

	/**
	 * Asks gh about each head in turn until one has a PR or gh fails (ADR
	 * 0055). When none has one, a PR already known is read by its number,
	 * so a head that moved, or a branch deleted after the merge, keeps it.
	 */
	private async lookup(session: Session): Promise<PrLookup> {
		const dir = workDir(session);
		const heads = await (this.host.heads ?? resolveHeads)(session).catch(() => [
			session.branch as string,
		]);
		let lookup: PrLookup = { pr: null, error: null };
		for (const head of heads) {
			lookup = await this.host.gh.viewPr(dir, head);
			if (lookup.pr || lookup.error) return lookup;
		}
		const known: PrInfo | null = session.pr;
		if (known) return this.host.gh.viewPr(dir, String(known.number));
		return lookup;
	}

	private retryLater(session: Session, limited = false): void {
		const n = this.retries.get(session.id) ?? 0;
		if (n >= PR_RETRIES) {
			this.host.log(
				`PR for ${session.name}: gh still failing, waiting for the next event`,
			);
			return;
		}
		this.retries.set(session.id, n + 1);
		const policy = limited
			? (this.host.rateLimitBackoff ?? PR_RATE_LIMITED)
			: (this.host.retryBackoff ?? PR_RETRY);
		// A rate limit waits its whole backoff; a blip is jittered (ADR 0043).
		const delay = limited
			? Math.min(policy.maxMs, policy.baseMs * 2 ** n)
			: backoffMs(n, policy);
		this.schedule(session.id, Math.max(this.host.debounceMs, delay));
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
		for (const timer of this.polls.values()) clearInterval(timer);
		this.polls.clear();
	}
}

/** Where gh and CODEOWNERS are read: the worktree, else the repo. */
export function workDir(session: Session): string {
	return session.worktree && existsSync(session.worktree)
		? session.worktree
		: session.repo;
}

/**
 * The heads a session's PR may be under (ADR 0055): the branch checked out
 * in its worktree (or, imported, in its directory), then the branch it was
 * started on, each with its upstream when that is the same work renamed.
 * The base branch never counts.
 */
export async function resolveHeads(session: Session): Promise<string[]> {
	const own =
		session.worktree ?? (session.origin === "adopted" ? session.cwd : null);
	const dir = own && existsSync(own) ? own : session.repo;
	const names = [
		own && existsSync(own) ? await checkedOutBranch(own) : null,
		session.branch,
	].filter((b): b is string => !!b);
	const branches: BranchFacts[] = [];
	for (const name of new Set(names))
		branches.push(
			(await branchFacts(dir, name).catch(() => null)) ?? {
				name,
				upstream: null,
				remote: null,
			},
		);
	const [base, owners] = await Promise.all([
		defaultBase(session.repo)
			.then((b) => b.replace(/^[^/]+\//, ""))
			.catch(() => null),
		remoteOwners(dir).catch(() => ({})),
	]);
	return prHeads({ branches, base, owners });
}

import type { Attachment, Interrupted, Session } from "@serenity/core";

/** What is true now, read once when the daemon starts. */
export interface RecoveryFacts {
	sessions: Session[];
	/** Attachments stored by the daemon before it stopped. */
	attached: Attachment[];
	/** Which of the panes the sessions and attachments name still exist. */
	livePanes: Set<string>;
	/** Whether a path still exists on disk. */
	exists(path: string): boolean;
	/**
	 * The tmux server the panes were in is gone (ADR 0070): a reboot, a
	 * shutdown or tmux killed, not the user closing a window. `livePanes`
	 * then holds only panes still marked with their session's id, since
	 * a new server reuses pane ids.
	 */
	serverLost?: boolean;
	/**
	 * With no server on record (the first start of a build that records
	 * it): when the running server started, in ms. A session last changed
	 * before then had its pane in an earlier server, so it was lost.
	 */
	serverStartedAt?: number;
	/**
	 * Also only on that first start: when the machine booted, in ms. A
	 * session an older build ended since then, for no reason it recorded,
	 * was most likely lost with the server, and is restored once.
	 */
	bootedAt?: number;
}

/** What the daemon does on start to match its storage to tmux and git (ADR 0045). */
export interface RecoveryPlan {
	/** Hook-tracked sessions whose pane went away while no daemon was watching. */
	ended: string[];
	/** Live sessions whose pane went away with the tmux server: restore them (ADR 0070). */
	interrupted: string[];
	/** Sessions an older build ended after this boot without a reason: restore them once. */
	catchUp: string[];
	/** Sessions whose worktree folder is gone, so cleanup does not try to remove it. */
	worktreeGone: string[];
	/** Attachments still true: both panes alive. */
	attached: Attachment[];
	/** Spawned sessions left joined beside a map that is gone: park them again. */
	park: string[];
	/** Sessions not heard from yet: start the startup grace again. */
	watchStartup: string[];
}

const live = (s: Session) => s.status !== "dead" && s.status !== "archived";

export function recoveryPlan(facts: RecoveryFacts): RecoveryPlan {
	const plan: RecoveryPlan = {
		ended: [],
		interrupted: [],
		catchUp: [],
		worktreeGone: [],
		attached: [],
		park: [],
		watchStartup: [],
	};
	const alive = new Set<string>();
	for (const s of facts.sessions) {
		if (s.worktree && s.status !== "archived" && !facts.exists(s.worktree))
			plan.worktreeGone.push(s.id);
		if (endedByOlderBuild(s, facts.bootedAt) && facts.exists(s.cwd))
			plan.catchUp.push(s.id);
		if (!live(s)) continue;
		// A pane made before the server started was in another server; its id may name another pane now.
		const olderServer =
			facts.serverStartedAt !== undefined &&
			s.updatedAt < facts.serverStartedAt;
		const paneGone =
			olderServer || !s.tmuxPane || !facts.livePanes.has(s.tmuxPane);
		if (paneGone && (facts.serverLost || olderServer) && restorable(s)) {
			plan.interrupted.push(s.id);
			continue;
		}
		// Observed sessions are checked against their claude process by the sweep.
		if (s.tracking === "observed") {
			alive.add(s.id);
			continue;
		}
		if (paneGone) {
			plan.ended.push(s.id);
			continue;
		}
		alive.add(s.id);
		if (s.status === "idle" && !s.claudeSessionId) plan.watchStartup.push(s.id);
	}
	const byId = new Map(facts.sessions.map((s) => [s.id, s]));
	const repos = new Set<string>();
	for (const a of facts.attached) {
		const s = byId.get(a.sessionId);
		if (!s || !alive.has(s.id) || repos.has(a.repo)) continue;
		const paneAlive = !!s.tmuxPane && facts.livePanes.has(s.tmuxPane);
		if (paneAlive && facts.livePanes.has(a.clientPane)) {
			plan.attached.push(a);
			repos.add(a.repo);
		} else if (paneAlive && s.origin === "spawned") {
			plan.park.push(s.id);
		}
	}
	return plan;
}

/**
 * A session a build before ADR 0070 ended since the machine booted, with
 * no reason given: what the old reconcile did to every session after a
 * reboot. Claude's own exits leave a reason (ADR 0044); the user's own
 * ending archives. It needs a conversation to resume.
 */
function endedByOlderBuild(s: Session, bootedAt: number | undefined): boolean {
	return (
		bootedAt !== undefined &&
		s.status === "dead" &&
		!s.exitNote &&
		!s.interrupted &&
		s.origin !== "imported" &&
		!!s.claudeSessionId &&
		s.updatedAt >= bootedAt
	);
}

/**
 * Whether a session lost with the tmux server comes back (ADR 0070): one
 * that was live, not one that had finished. A done session's work is over,
 * and serenity would offer to clean it up, so it stays ended.
 */
export function restorable(
	s: Session,
): s is Session & { status: Interrupted["status"] } {
	return (
		s.status === "idle" || s.status === "working" || s.status === "waiting"
	);
}

/** What an interrupted session keeps of how it was, for its note once restored. */
export function interruptedFrom(s: Session, at: number): Interrupted | null {
	return restorable(s)
		? { status: s.status, waitingOn: s.waitingOn, at }
		: null;
}

/** The note on a session lost with the tmux server, until it is restored. */
export const INTERRUPTED_NOTE = "tmux stopped (a restart or shutdown)";

export interface RestorePlan {
	/** Session ids to resume, in this order. */
	restore: string[];
	/** Sessions that cannot come back, with why; they stay ended. */
	skip: { id: string; reason: string }[];
}

/**
 * Which of a repo's interrupted sessions can be resumed (ADR 0070): each
 * needs its Claude conversation and the folder it ran in. Oldest first, so
 * a fan-out parent comes back before its children. Pure, like recoveryPlan.
 */
export function restorePlan(
	sessions: Session[],
	exists: (path: string) => boolean,
): RestorePlan {
	const plan: RestorePlan = { restore: [], skip: [] };
	const waiting = sessions
		.filter((s) => s.interrupted && s.status === "dead")
		.sort((a, b) => a.createdAt - b.createdAt);
	for (const s of waiting) {
		const reason = !s.claudeSessionId
			? "it had not started a conversation yet"
			: !exists(s.cwd)
				? `its folder ${s.cwd} is gone`
				: s.transcriptPath && !exists(s.transcriptPath)
					? "its conversation transcript is missing"
					: null;
		if (reason) plan.skip.push({ id: s.id, reason });
		else plan.restore.push(s.id);
	}
	return plan;
}

/**
 * The note a restored session shows until its next prompt (ADR 0070):
 * claude comes back idle, so what it was doing then needs saying.
 */
export function restoredNote(from: Interrupted): string {
	if (from.status === "waiting" && from.waitingOn === "permission")
		return "restored after a restart; the permission prompt it waited on was lost, so ask it to go on";
	if (from.status === "waiting")
		return "restored after a restart; it was waiting on you";
	if (from.status === "working")
		return "restored after a restart; its turn was cut short, so ask it to go on";
	return "restored after a restart";
}

/**
 * Whether the tmux server the panes were in is gone (ADR 0070): none runs
 * now, or one other than the one recorded does. With none recorded (a
 * first start) a running server is taken as the panes' own.
 */
export function serverGone(known: string | null, now: string | null): boolean {
	return (
		now === null || (!!known && known !== NO_SERVER_KNOWN && known !== now)
	);
}

/** Recorded when no tmux server ran, so a record exists even then. */
export const NO_SERVER_KNOWN = "none";

/** When a server id (`pid:start_time`, seconds) says it started, in ms. */
export function serverStartedAt(id: string): number | undefined {
	const start = Number(id.split(":")[1]);
	return Number.isFinite(start) && start > 0 ? start * 1000 : undefined;
}

/**
 * The boot time, in ms, from `sysctl -n kern.boottime` (macOS: "{ sec =
 * 1795545119, usec = 967580 } …") or /proc/stat's "btime 1795545119" (Linux).
 */
export function parseBootTime(text: string): number | undefined {
	const sec =
		text.match(/\bsec = (\d+)/)?.[1] ?? text.match(/^btime (\d+)/m)?.[1];
	return sec ? Number(sec) * 1000 : undefined;
}

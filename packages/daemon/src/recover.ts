import type { Attachment, Session } from "@serenity/core";

/** What is true now, read once when the daemon starts. */
export interface RecoveryFacts {
	sessions: Session[];
	/** Attachments stored by the daemon before it stopped. */
	attached: Attachment[];
	/** Which of the panes the sessions and attachments name still exist. */
	livePanes: Set<string>;
	/** Whether a path still exists on disk. */
	exists(path: string): boolean;
}

/** What the daemon does on start to match its storage to tmux and git (ADR 0045). */
export interface RecoveryPlan {
	/** Hook-tracked sessions whose pane went away while no daemon was watching. */
	ended: string[];
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
		worktreeGone: [],
		attached: [],
		park: [],
		watchStartup: [],
	};
	const alive = new Set<string>();
	for (const s of facts.sessions) {
		if (s.worktree && s.status !== "archived" && !facts.exists(s.worktree))
			plan.worktreeGone.push(s.id);
		if (!live(s)) continue;
		// Observed sessions are checked against their claude process by the sweep.
		if (s.tracking === "observed") {
			alive.add(s.id);
			continue;
		}
		if (!s.tmuxPane || !facts.livePanes.has(s.tmuxPane)) {
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

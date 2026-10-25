import type { CleanupPlan, Session } from "@serenity/core";

/** What git says about a session's worktree and branch. */
export interface CleanupFacts {
	/** The agent's pane still exists. */
	alive: boolean;
	/** Changed or untracked files in the worktree; null without a worktree. */
	dirty: number | null;
	/** Commits on the branch that the base lacks; null when not checked. */
	unmerged: number | null;
	base: string;
}

/**
 * The Confirm overlay's content (design 4b), decided by serenity from git
 * facts, never by the model (ADR 0008). Nothing that holds work is removed:
 * a worktree with changes and a branch with unmerged commits are kept.
 */
export function cleanupPlan(
	session: Session,
	facts: CleanupFacts,
): CleanupPlan {
	const steps: string[] = [];
	const safety: string[] = [];
	if (facts.alive) steps.push(`stop the session ${session.name}`);

	if (session.worktree) {
		if (facts.dirty === 0) steps.push(`remove worktree ${session.worktree}`);
		else steps.push(`keep worktree ${session.worktree}`);
		safety.push(
			facts.dirty === 0
				? "no uncommitted changes"
				: `${facts.dirty} uncommitted ${facts.dirty === 1 ? "change" : "changes"}`,
		);
	}

	if (session.branch && session.ownsBranch) {
		if (plannedRemovals(session, facts).deleteBranch)
			steps.push(`delete branch ${session.branch} · merged into ${facts.base}`);
		else steps.push(`keep branch ${session.branch}`);
		safety.push(
			facts.unmerged === 0
				? `no commits missing from ${facts.base}`
				: `${facts.unmerged} ${facts.unmerged === 1 ? "commit" : "commits"} not in ${facts.base}`,
		);
	}

	steps.push(
		`keep the node on the map, archived${session.category ? ` inside ${session.category}` : ""}`,
	);
	const safe = (facts.dirty ?? 0) === 0 && (facts.unmerged ?? 0) === 0;
	return { steps, safety, safe };
}

/**
 * Whether the plan removes the worktree / deletes the branch. A branch still
 * checked out in a kept worktree cannot be deleted, merged or not.
 */
export function plannedRemovals(session: Session, facts: CleanupFacts) {
	const removeWorktree = !!session.worktree && facts.dirty === 0;
	return {
		removeWorktree,
		deleteBranch:
			!!session.branch &&
			session.ownsBranch &&
			facts.unmerged === 0 &&
			(!session.worktree || removeWorktree),
	};
}

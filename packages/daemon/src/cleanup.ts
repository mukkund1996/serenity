import type { CleanupPlan, Session } from "@serenity/core";

/** What git (and gh) say about a session's worktree and branch. */
export interface CleanupFacts {
	/** The agent's pane still exists. */
	alive: boolean;
	/** Changed or untracked files in the worktree; null without a worktree. */
	dirty: number | null;
	/** Commits on the branch that the base lacks; null when not checked. */
	unmerged: number | null;
	base: string;
	/**
	 * The number of the branch's merged PR when that PR's head is the branch's
	 * current commit. Squash and rebase merges leave such a branch "unmerged"
	 * to git, yet nothing on it is lost (ADR 0011).
	 */
	prMerged: number | null;
}

/**
 * The Confirm overlay's content (design 4b), decided by serenity from git
 * and gh facts, never by the model (ADR 0008). Nothing that holds work is
 * removed: a worktree with changes and a branch with unmerged commits are kept.
 */
export function cleanupPlan(
	session: Session,
	facts: CleanupFacts,
): CleanupPlan {
	const steps: string[] = [];
	const safety: string[] = [];
	if (facts.alive)
		steps.push(
			session.tracking === "observed"
				? `stop claude in ${session.name} · its tmux window stays`
				: `stop the session ${session.name}`,
		);

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
		const merged =
			facts.prMerged !== null
				? `PR #${facts.prMerged} merged`
				: `merged into ${facts.base}`;
		if (plannedRemovals(session, facts).deleteBranch)
			steps.push(`delete branch ${session.branch} · ${merged}`);
		else steps.push(`keep branch ${session.branch}`);
		safety.push(
			facts.prMerged !== null
				? `PR #${facts.prMerged} merged`
				: facts.unmerged === 0
					? `no commits missing from ${facts.base}`
					: `${facts.unmerged} ${facts.unmerged === 1 ? "commit" : "commits"} not in ${facts.base}`,
		);
	}

	steps.push(
		`keep the node on the map, archived${session.category ? ` inside ${session.category}` : ""}`,
	);
	const branchSafe = facts.prMerged !== null || (facts.unmerged ?? 0) === 0;
	const safe = (facts.dirty ?? 0) === 0 && branchSafe;
	return { steps, safety, safe };
}

/**
 * Whether the plan removes the worktree / deletes the branch, and whether the
 * delete must be forced (`git branch -D`) because only the merged PR, not
 * git, shows the branch is merged. A branch still checked out in a kept
 * worktree cannot be deleted, merged or not.
 */
export function plannedRemovals(session: Session, facts: CleanupFacts) {
	const removeWorktree = !!session.worktree && facts.dirty === 0;
	const merged = facts.unmerged === 0 || facts.prMerged !== null;
	const deleteBranch =
		!!session.branch &&
		session.ownsBranch &&
		merged &&
		(!session.worktree || removeWorktree);
	return {
		removeWorktree,
		deleteBranch,
		forceDelete: deleteBranch && facts.unmerged !== 0,
	};
}

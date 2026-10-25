import { describe, expect, test } from "bun:test";
import { makeSession } from "@serenity/core/testing";
import { cleanupPlan, plannedRemovals } from "../src/cleanup";

const session = makeSession({
	name: "studio-editor",
	category: "studio",
	worktree: "/r/demo-studio-editor",
	branch: "studio-editor",
	ownsBranch: true,
});
const clean = { alive: true, dirty: 0, unmerged: 0, base: "main" };

describe("cleanupPlan", () => {
	test("a clean, merged session is stopped, its worktree removed and branch deleted", () => {
		expect(cleanupPlan(session, clean)).toEqual({
			steps: [
				"stop the session studio-editor",
				"remove worktree /r/demo-studio-editor",
				"delete branch studio-editor · merged into main",
				"keep the node on the map, archived inside studio",
			],
			safety: ["no uncommitted changes", "no commits missing from main"],
			safe: true,
		});
		expect(plannedRemovals(session, clean)).toEqual({
			removeWorktree: true,
			deleteBranch: true,
		});
	});

	test("work is never removed: dirty worktrees and unmerged branches are kept", () => {
		const facts = { alive: false, dirty: 3, unmerged: 1, base: "main" };
		const plan = cleanupPlan(session, facts);
		expect(plan.safe).toBe(false);
		expect(plan.steps).toEqual([
			"keep worktree /r/demo-studio-editor",
			"keep branch studio-editor",
			"keep the node on the map, archived inside studio",
		]);
		expect(plan.safety).toEqual([
			"3 uncommitted changes",
			"1 commit not in main",
		]);
		expect(plannedRemovals(session, facts)).toEqual({
			removeWorktree: false,
			deleteBranch: false,
		});
	});

	test("a merged branch stays while its worktree is kept", () => {
		const facts = { alive: false, dirty: 2, unmerged: 0, base: "main" };
		expect(plannedRemovals(session, facts).deleteBranch).toBe(false);
		expect(cleanupPlan(session, facts).steps).toContain(
			"keep branch studio-editor",
		);
	});

	test("a branch serenity did not create is never deleted", () => {
		const theirs = { ...session, ownsBranch: false };
		expect(
			cleanupPlan(theirs, clean).steps.some((s) => s.includes("branch")),
		).toBe(false);
		expect(plannedRemovals(theirs, clean).deleteBranch).toBe(false);
	});
});

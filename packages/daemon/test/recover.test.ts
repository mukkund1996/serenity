import { expect, test } from "bun:test";
import { makeSession } from "@serenity/core/testing";
import { recoveryPlan } from "../src/recover";

const facts = (over: Partial<Parameters<typeof recoveryPlan>[0]> = {}) => ({
	sessions: [],
	attached: [],
	livePanes: new Set<string>(),
	exists: () => true,
	...over,
});

test("a hook-tracked session whose pane closed while the daemon was down has ended", () => {
	const plan = recoveryPlan(
		facts({
			sessions: [
				makeSession({ id: "gone", tmuxPane: "%1", status: "working" }),
				makeSession({ id: "here", tmuxPane: "%2", status: "working" }),
				makeSession({ id: "nopane", tmuxPane: null, status: "idle" }),
				makeSession({ id: "dead", tmuxPane: "%3", status: "dead" }),
				makeSession({ id: "obs", tmuxPane: "%4", tracking: "observed" }),
			],
			livePanes: new Set(["%2"]),
		}),
	);
	expect(plan.ended).toEqual(["gone", "nopane"]);
});

test("worktrees deleted behind serenity's back are forgotten", () => {
	const plan = recoveryPlan(
		facts({
			sessions: [
				makeSession({ id: "a", worktree: "/w/a", status: "dead" }),
				makeSession({ id: "b", worktree: "/w/b", status: "dead" }),
				makeSession({ id: "c", worktree: "/w/c", status: "archived" }),
			],
			exists: (p) => p === "/w/b",
		}),
	);
	expect(plan.worktreeGone).toEqual(["a"]);
});

test("an attachment stays while both panes live; a stranded spawned pane is parked", () => {
	const plan = recoveryPlan(
		facts({
			sessions: [
				makeSession({ id: "a", repo: "/r1", tmuxPane: "%1" }),
				makeSession({ id: "b", repo: "/r2", tmuxPane: "%2" }),
				makeSession({
					id: "c",
					repo: "/r3",
					tmuxPane: "%3",
					origin: "adopted",
				}),
				makeSession({ id: "d", repo: "/r4", tmuxPane: "%4" }),
			],
			attached: [
				{ repo: "/r1", sessionId: "a", clientPane: "%10" },
				{ repo: "/r2", sessionId: "b", clientPane: "%20" },
				{ repo: "/r3", sessionId: "c", clientPane: "%30", clientTty: "/dev/x" },
				{ repo: "/r4", sessionId: "d", clientPane: "%40" },
			],
			livePanes: new Set(["%1", "%10", "%2", "%3", "%40"]),
		}),
	);
	expect(plan.attached).toEqual([
		{ repo: "/r1", sessionId: "a", clientPane: "%10" },
	]);
	expect(plan.park).toEqual(["b"]);
	expect(plan.ended).toEqual(["d"]);
});

test("sessions that never said hello get their startup grace again", () => {
	const plan = recoveryPlan(
		facts({
			sessions: [
				makeSession({ id: "new", tmuxPane: "%1", status: "idle" }),
				makeSession({
					id: "known",
					tmuxPane: "%2",
					status: "idle",
					claudeSessionId: "c",
				}),
			],
			livePanes: new Set(["%1", "%2"]),
		}),
	);
	expect(plan.watchStartup).toEqual(["new"]);
});

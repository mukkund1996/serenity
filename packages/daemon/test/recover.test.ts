import { describe, expect, test } from "bun:test";
import type { Session } from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import {
	INTERRUPTED_NOTE,
	interruptedFrom,
	NO_SERVER_KNOWN,
	parseBootTime,
	recoveryPlan,
	restoredNote,
	restorePlan,
	serverGone,
	serverStartedAt,
} from "../src/recover";

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

describe("after the tmux server went away (ADR 0070)", () => {
	const sessions = [
		makeSession({ id: "idle", tmuxPane: "%1", status: "idle" }),
		makeSession({ id: "work", tmuxPane: "%2", status: "working" }),
		makeSession({ id: "wait", tmuxPane: "%3", status: "waiting" }),
		makeSession({ id: "done", tmuxPane: "%4", status: "done" }),
		makeSession({ id: "dead", tmuxPane: "%5", status: "dead" }),
		makeSession({ id: "arch", tmuxPane: null, status: "archived" }),
		makeSession({ id: "obs", tmuxPane: "%6", tracking: "observed" }),
		makeSession({ id: "kept", tmuxPane: "%7", status: "idle" }),
	];

	test("live sessions are interrupted; done ones end; ended and archived stay", () => {
		const plan = recoveryPlan(
			facts({ sessions, serverLost: true, livePanes: new Set(["%7"]) }),
		);
		expect(plan.interrupted).toEqual(["idle", "work", "wait", "obs"]);
		expect(plan.ended).toEqual(["done"]);
	});

	test("with the same server, a missing pane was closed: the session ended", () => {
		const plan = recoveryPlan(facts({ sessions, livePanes: new Set(["%7"]) }));
		expect(plan.interrupted).toEqual([]);
		expect(plan.ended).toEqual(["idle", "work", "wait", "done"]);
	});

	test("attachments do not survive the server", () => {
		const plan = recoveryPlan(
			facts({
				sessions,
				serverLost: true,
				livePanes: new Set(["%7"]),
				attached: [
					{ repo: "/repos/demo", sessionId: "idle", clientPane: "%9" },
				],
			}),
		);
		expect(plan.attached).toEqual([]);
		expect(plan.park).toEqual([]);
	});

	test("the server is gone when none runs, or another than the one recorded", () => {
		expect(serverGone("1:100", null)).toBe(true);
		expect(serverGone(null, null)).toBe(true);
		expect(serverGone("1:100", "2:200")).toBe(true);
		expect(serverGone("1:100", "1:100")).toBe(false);
		// A first start has nothing to compare with.
		expect(serverGone(null, "1:100")).toBe(false);
	});

	test("an interrupted session keeps how it was", () => {
		expect(
			interruptedFrom(
				makeSession({ status: "waiting", waitingOn: "permission" }),
				5,
			),
		).toEqual({ status: "waiting", waitingOn: "permission", at: 5 });
		expect(interruptedFrom(makeSession({ status: "done" }), 5)).toBeNull();
	});
});

describe("restorePlan", () => {
	const lost = (over: Partial<Session>) =>
		makeSession({
			status: "dead",
			claudeSessionId: "c",
			exitNote: INTERRUPTED_NOTE,
			interrupted: { status: "idle", waitingOn: null, at: 1 },
			...over,
		});

	test("resumes interrupted sessions oldest first; skips what cannot come back", () => {
		const plan = restorePlan(
			[
				lost({ id: "b", createdAt: 2, cwd: "/w/b" }),
				lost({ id: "a", createdAt: 1, cwd: "/w/a" }),
				lost({ id: "nochat", claudeSessionId: null }),
				lost({ id: "gone", cwd: "/w/gone" }),
				lost({ id: "notranscript", transcriptPath: "/t/x.jsonl" }),
				makeSession({ id: "ended", status: "dead", claudeSessionId: "c" }),
				lost({ id: "archived", status: "archived" }),
				lost({ id: "back", status: "idle" }),
			],
			(p) => !p.includes("gone") && !p.startsWith("/t/"),
		);
		expect(plan.restore).toEqual(["a", "b"]);
		expect(plan.skip).toEqual([
			{ id: "nochat", reason: "it had not started a conversation yet" },
			{ id: "gone", reason: "its folder /w/gone is gone" },
			{ id: "notranscript", reason: "its conversation transcript is missing" },
		]);
	});

	test("running it again after a restore finds nothing to do", () => {
		const restored = lost({ id: "a", status: "idle", interrupted: null });
		expect(restorePlan([restored], () => true)).toEqual({
			restore: [],
			skip: [],
		});
	});

	test("a restored session says what it was doing", () => {
		expect(
			restoredNote({ status: "waiting", waitingOn: "permission", at: 1 }),
		).toContain("permission prompt it waited on was lost");
		expect(
			restoredNote({ status: "working", waitingOn: null, at: 1 }),
		).toContain("cut short");
		expect(restoredNote({ status: "idle", waitingOn: null, at: 1 })).toBe(
			"restored after a restart",
		);
	});
});

describe("the first start of a build that records the server (ADR 0070)", () => {
	test("a session last changed before the server started was in another one", () => {
		const plan = recoveryPlan(
			facts({
				sessions: [
					makeSession({ id: "old", tmuxPane: "%1", updatedAt: 500 }),
					makeSession({ id: "new", tmuxPane: "%2", updatedAt: 1500 }),
					makeSession({ id: "gone", tmuxPane: "%3", updatedAt: 1500 }),
				],
				// %1 exists, but in the new server it is some other pane.
				livePanes: new Set(["%1", "%2"]),
				serverStartedAt: 1000,
			}),
		);
		expect(plan.interrupted).toEqual(["old"]);
		expect(plan.ended).toEqual(["gone"]);
	});

	test("sessions an older build ended since boot, for no reason, are caught up once", () => {
		const dead = (over: Partial<Session>) =>
			makeSession({
				status: "dead",
				claudeSessionId: "c",
				updatedAt: 2000,
				...over,
			});
		const sessions = [
			dead({ id: "lost" }),
			dead({ id: "before-boot", updatedAt: 500 }),
			dead({ id: "crashed", exitNote: "claude exited 6 times" }),
			dead({ id: "nochat", claudeSessionId: null }),
			dead({ id: "imported", origin: "imported" }),
			dead({ id: "nofolder", cwd: "/gone" }),
			dead({ id: "archived", status: "archived" }),
		];
		const plan = recoveryPlan(
			facts({ sessions, bootedAt: 1000, exists: (p) => p !== "/gone" }),
		);
		expect(plan.catchUp).toEqual(["lost"]);
		// Without a boot time (every later start) nothing is caught up.
		expect(recoveryPlan(facts({ sessions })).catchUp).toEqual([]);
	});

	test("no server on record, or none running, is told apart from a new one", () => {
		expect(serverGone(NO_SERVER_KNOWN, "1:100")).toBe(false);
		expect(serverGone(NO_SERVER_KNOWN, null)).toBe(true);
		expect(serverStartedAt("4253:1795592117")).toBe(1795592117000);
		expect(serverStartedAt("bad")).toBeUndefined();
	});

	test("boot time from macOS sysctl or Linux /proc/stat", () => {
		expect(
			parseBootTime(
				"{ sec = 1795545119, usec = 967580 } Tue Nov 24 19:31:59 2026",
			),
		).toBe(1795545119000);
		expect(parseBootTime("cpu 1 2 3\nbtime 1795545119\nprocesses 9")).toBe(
			1795545119000,
		);
		expect(parseBootTime("nothing")).toBeUndefined();
	});
});

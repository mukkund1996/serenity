import { expect, test } from "bun:test";
import { makeSession } from "@serenity/core/testing";
import {
	askLine,
	cardText,
	masterTurnLabel,
	RESTORE_NEWS_MS,
	restoreNotice,
} from "../src/theme";

test("an ended session's card and NEEDS YOU line say why it was not restarted", () => {
	const dead = makeSession({
		status: "dead",
		exitNote: "claude exited 6 times in 10 min (last with code 1)",
	});
	expect(cardText(dead)).toBe(
		"Session ended: claude exited 6 times in 10 min (last with code 1).",
	);
	expect(askLine(dead)).toBe(
		"ended: claude exited 6 times in 10 min (last with code 1)",
	);
	expect(cardText(makeSession({ status: "dead" }))).toBe("Session ended.");
});

test("a restarted session's card says so until the next prompt", () => {
	const note = "claude exited (code 0); restarted";
	expect(cardText(makeSession({ exitNote: note }))).toBe(
		"Claude exited (code 0); restarted.",
	);
	expect(
		cardText(makeSession({ exitNote: note, summary: "Fixing auth." })),
	).toBe("Claude exited (code 0); restarted. Fixing auth.");
});

test("the master's turn label tells a long turn from a quiet one (issue #106)", () => {
	const turn = { startedAt: 0, lastOutputAt: 0, waitingOn: null };
	expect(masterTurnLabel(undefined, 5_000)).toBe("thinking");
	expect(masterTurnLabel(turn, 12_000)).toBe("working 12s");
	expect(masterTurnLabel({ ...turn, lastOutputAt: 60_000 }, 65_000)).toBe(
		"working 1m05s",
	);
	expect(masterTurnLabel({ ...turn, lastOutputAt: 10_000 }, 190_000)).toBe(
		"working 3m10s · quiet 3m00s",
	);
	expect(masterTurnLabel({ ...turn, waitingOn: "you" as const }, 130_000)).toBe(
		"waiting on you 2m10s",
	);
	// A serenity tool runs: quiet is expected, and bounded by its own timeout.
	expect(masterTurnLabel({ ...turn, waitingOn: "tool" as const }, 90_000)).toBe(
		"working 1m30s",
	);
});

test("a session lost with the tmux server says so, and that Enter resumes it (ADR 0070)", () => {
	const lost = makeSession({
		status: "dead",
		exitNote: "tmux stopped (a restart or shutdown)",
		interrupted: { status: "working", waitingOn: null, at: 1 },
	});
	expect(cardText(lost)).toBe(
		"Ended: tmux stopped (a restart or shutdown). Enter resumes it.",
	);
});

test("the restore notice: under way, then what came back and what did not", () => {
	const report = { id: 1000, pending: 3, restored: [], failed: [] };
	expect(restoreNotice(report, 1000)).toBe(
		"restoring 3 sessions after a restart…",
	);
	expect(
		restoreNotice(
			{ ...report, pending: 0, restored: ["api", "web"], failed: [] },
			2000,
		),
	).toBe("restored 2 sessions after a restart");
	expect(
		restoreNotice(
			{
				...report,
				pending: 0,
				restored: ["api"],
				failed: [{ name: "docs", reason: "its folder /w/docs is gone" }],
			},
			2000,
		),
	).toBe(
		"restored 1 session after a restart · not restored: docs (its folder /w/docs is gone)",
	);
	expect(
		restoreNotice(
			{ ...report, pending: 0, failed: [{ name: "x", reason: "why" }] },
			2000,
		),
	).toBe("not restored after a restart: x (why)");
	// A map opened long after a finished restore does not repeat it.
	expect(
		restoreNotice(
			{ ...report, pending: 0, restored: ["api"] },
			1000 + RESTORE_NEWS_MS + 1,
		),
	).toBeNull();
	expect(restoreNotice(null, 0)).toBeNull();
});

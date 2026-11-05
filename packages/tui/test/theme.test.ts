import { expect, test } from "bun:test";
import { makeSession } from "@serenity/core/testing";
import { askLine, cardText, masterTurnLabel } from "../src/theme";

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

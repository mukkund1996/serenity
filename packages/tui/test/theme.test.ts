import { expect, test } from "bun:test";
import { makeSession } from "@serenity/core/testing";
import { askLine, cardText } from "../src/theme";

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

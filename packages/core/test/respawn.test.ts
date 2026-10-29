import { describe, expect, test } from "bun:test";
import { RESPAWN_LIMIT, respawnDecision, resumeArgs } from "../src/respawn";
import { makeSession } from "../test-support";

const started = makeSession({ claudeSessionId: "c1", status: "working" });

describe("respawnDecision", () => {
	test("an archived session ended on purpose; nothing restarts", () => {
		expect(respawnDecision(makeSession({ status: "archived" }), 0, 0)).toEqual({
			kind: "ignore",
		});
		expect(respawnDecision(makeSession({ status: "dead" }), 0, 0)).toEqual({
			kind: "ignore",
		});
	});

	test("a claude that never started stays ended, with the reason", () => {
		expect(respawnDecision(makeSession(), 0, 0)).toEqual({
			kind: "end",
			reason: "claude exited before it started (code 0)",
		});
	});

	test("any other exit restarts, a clean one included", () => {
		for (const code of [0, 1, 130, null])
			expect(respawnDecision(started, code, 0).kind).toBe("respawn");
	});

	test("each restart in the window waits twice as long", () => {
		const delays = Array.from({ length: RESPAWN_LIMIT }, (_, recent) => {
			const decision = respawnDecision(started, 1, recent);
			return decision.kind === "respawn" ? decision.delayMs : -1;
		});
		expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);
		expect(respawnDecision(started, 1, 0, 50)).toMatchObject({ delayMs: 50 });
	});

	test("the restart note names the exit code", () => {
		expect(respawnDecision(started, 1, 0)).toMatchObject({
			note: "claude exited (code 1); restarted",
		});
		expect(respawnDecision(started, null, 0)).toMatchObject({
			note: "claude exited (an unknown code); restarted",
		});
	});

	test("past the limit the session ends, saying it kept exiting", () => {
		expect(respawnDecision(started, 1, RESPAWN_LIMIT)).toEqual({
			kind: "end",
			reason: "claude exited 6 times in 10 min (last with code 1)",
		});
	});
});

test("a restart resumes the conversation, or the latest one if none is known", () => {
	expect(resumeArgs(started)).toEqual(["--resume", "c1"]);
	expect(resumeArgs(makeSession())).toEqual(["--continue"]);
});

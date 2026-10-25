import { describe, expect, test } from "bun:test";
import { reduceHook } from "../src/status";
import { makeSession } from "../test-support";

describe("reduceHook", () => {
	test("session start is idle and records claude ids", () => {
		const patch = reduceHook(
			makeSession({ status: "working" }),
			"SessionStart",
			{
				session_id: "c-1",
				transcript_path: "/t.jsonl",
			},
		);
		expect(patch).toEqual({
			status: "idle",
			ask: null,
			claudeSessionId: "c-1",
			transcriptPath: "/t.jsonl",
		});
	});

	test("a prompt starts work and clears the ask and the older reply", () => {
		const patch = reduceHook(
			makeSession({ status: "waiting", ask: "x" }),
			"UserPromptSubmit",
			{
				prompt: "rotate  refresh\ntokens",
			},
		);
		expect(patch).toEqual({
			status: "working",
			ask: null,
			lastPrompt: "rotate refresh tokens",
			lastAssistantMessage: null,
		});
	});

	test("permission prompts make the session wait", () => {
		expect(
			reduceHook(makeSession(), "PermissionRequest", { tool_name: "Bash" }),
		).toMatchObject({
			status: "waiting",
			ask: "wants to use Bash",
		});
		expect(
			reduceHook(makeSession(), "Notification", {
				notification_type: "permission_prompt",
				message: "Claude needs your permission to use Bash",
			}),
		).toMatchObject({
			status: "waiting",
			ask: "Claude needs your permission to use Bash",
		});
	});

	test("a permission request names the command and outlives the generic notification", () => {
		const ask = reduceHook(makeSession(), "PermissionRequest", {
			tool_name: "Bash",
			tool_input: { command: "terraform apply" },
		}).ask;
		expect(ask).toBe("wants to run terraform apply");
		const waiting = makeSession({ status: "waiting", ask });
		expect(
			reduceHook(waiting, "Notification", {
				notification_type: "permission_prompt",
				message: "Claude needs your permission",
			}),
		).toEqual({ status: "waiting" });
	});

	test("idle notifications do not change status", () => {
		const patch = reduceHook(makeSession({ status: "idle" }), "Notification", {
			notification_type: "idle_prompt",
			message: "Claude is waiting for your input",
		});
		expect(patch.status).toBeUndefined();
	});

	test("a tool finishing after a permission prompt resumes work", () => {
		expect(
			reduceHook(
				makeSession({ status: "waiting", ask: "x" }),
				"PostToolUse",
				{},
			),
		).toEqual({
			status: "working",
			ask: null,
		});
		expect(
			reduceHook(makeSession({ status: "working" }), "PostToolUse", {}),
		).toEqual({});
	});

	test("stop is idle and keeps the last assistant message", () => {
		expect(
			reduceHook(makeSession({ status: "working" }), "Stop", {
				last_assistant_message: "All done.",
			}),
		).toEqual({
			status: "idle",
			ask: null,
			lastAssistantMessage: "All done.",
		});
	});

	test("session end is dead; archived is sticky", () => {
		expect(reduceHook(makeSession(), "SessionEnd", {}).status).toBe("dead");
		expect(
			reduceHook(makeSession({ status: "archived" }), "UserPromptSubmit", {
				prompt: "hi",
			}),
		).toEqual({});
	});
});

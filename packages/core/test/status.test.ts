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
			waitingOn: null,
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
			waitingOn: null,
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
			waitingOn: "permission",
		});
		expect(
			reduceHook(makeSession(), "Notification", {
				notification_type: "permission_prompt",
				message: "Claude needs your permission to use Bash",
			}),
		).toMatchObject({
			status: "waiting",
			ask: "Claude needs your permission to use Bash",
			waitingOn: "permission",
		});
		expect(
			reduceHook(makeSession(), "Notification", {
				notification_type: "elicitation_dialog",
				message: "Pick a database",
			}),
		).toMatchObject({ status: "waiting", waitingOn: "question" });
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
		).toEqual({ status: "waiting", waitingOn: "permission" });
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
			waitingOn: null,
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
			waitingOn: null,
			lastAssistantMessage: "All done.",
		});
	});

	test("the reply is kept long enough for the summarizer", () => {
		const long = "word ".repeat(300);
		const kept = reduceHook(makeSession(), "Stop", {
			last_assistant_message: long,
		}).lastAssistantMessage as string;
		expect(kept.length).toBeGreaterThan(1000);
		expect(kept.length).toBeLessThanOrEqual(2000);
	});

	test("session end leaves the status to the exit report; archived is sticky", () => {
		expect(
			reduceHook(makeSession({ status: "working" }), "SessionEnd", {}).status,
		).toBeUndefined();
		expect(
			reduceHook(makeSession({ status: "archived" }), "UserPromptSubmit", {
				prompt: "hi",
			}),
		).toEqual({});
	});

	test("a tool starting means work, but never ends a wait", () => {
		for (const status of ["idle", "done"] as const)
			expect(
				reduceHook(makeSession({ status }), "PreToolUse", {
					tool_name: "Read",
				}),
			).toEqual({ status: "working", ask: null, waitingOn: null });
		expect(
			reduceHook(
				makeSession({ status: "waiting", ask: "x", waitingOn: "permission" }),
				"PreToolUse",
				{ tool_name: "Read", agent_id: "a-1" },
			),
		).toEqual({});
	});

	test("a done session that uses a tool again is working", () => {
		expect(
			reduceHook(makeSession({ status: "done" }), "PostToolUse", {}),
		).toMatchObject({ status: "working" });
	});

	test("a turn that ends while subagents run stays working until they stop", () => {
		let session = makeSession({ status: "working" });
		const apply = (kind: Parameters<typeof reduceHook>[1], agent?: string) => {
			session = {
				...session,
				...reduceHook(session, kind, {
					...(agent ? { agent_id: agent } : {}),
					last_assistant_message: "waiting on the agents",
				}),
			};
		};
		apply("SubagentStart", "a-1");
		apply("SubagentStart", "a-2");
		expect(session.subagents).toEqual(["a-1", "a-2"]);
		apply("Stop");
		expect(session.status).toBe("working");
		expect(session.lastAssistantMessage).toBe("waiting on the agents");
		apply("SubagentStop", "a-1");
		apply("Stop");
		expect(session.status).toBe("working");
		apply("SubagentStop", "a-2");
		expect(session.subagents).toEqual([]);
		apply("Stop");
		expect(session.status).toBe("idle");
	});

	test("a subagent starting wakes an idle session; an unknown stop changes nothing", () => {
		expect(
			reduceHook(makeSession({ status: "idle" }), "SubagentStart", {
				agent_id: "a-1",
			}),
		).toEqual({
			subagents: ["a-1"],
			status: "working",
			ask: null,
			waitingOn: null,
		});
		expect(
			reduceHook(makeSession(), "SubagentStop", { agent_id: "a-9" }),
		).toEqual({});
	});

	test("a prompt clears the note that claude was restarted", () => {
		const session = makeSession({
			exitNote: "claude exited (code 1); restarted",
		});
		expect(
			reduceHook(session, "UserPromptSubmit", { prompt: "go on" }).exitNote,
		).toBeNull();
		expect(reduceHook(session, "Stop", {}).exitNote).toBeUndefined();
	});

	test("a new or ended session forgets its subagents", () => {
		const session = makeSession({ status: "working", subagents: ["a-1"] });
		expect(reduceHook(session, "SessionStart", {}).subagents).toEqual([]);
		expect(reduceHook(session, "SessionEnd", {}).subagents).toEqual([]);
	});
});

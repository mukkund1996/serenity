#!/usr/bin/env bun
/**
 * A stand-in for `claude` in E2E tests (ADR 0013). It reads the hooks from
 * `--settings <file>` and fires them the way Claude Code would:
 *   any line          → UserPromptSubmit, then Stop ("Done: <line>")
 *   a line with "permission" → UserPromptSubmit, then a permission Notification;
 *                       the next line → PostToolUse, then Stop
 *   "exit"            → SessionEnd, then exit
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
	console.log("0.0.0 (fake claude)");
	process.exit(0);
}

const settingsPath = args[args.indexOf("--settings") + 1];
const settings = settingsPath
	? JSON.parse(readFileSync(settingsPath, "utf8"))
	: { hooks: {} };
const sessionId = `fake-${process.pid}`;

function fire(event: string, extra: Record<string, unknown> = {}): void {
	const payload = JSON.stringify({
		session_id: sessionId,
		transcript_path: `/tmp/${sessionId}.jsonl`,
		hook_event_name: event,
		...extra,
	});
	for (const group of settings.hooks[event] ?? []) {
		for (const hook of group.hooks)
			spawnSync("sh", ["-c", hook.command], {
				input: payload,
				stdio: ["pipe", "ignore", "inherit"],
			});
	}
}

fire("SessionStart", { source: "startup" });
process.stdout.write("fake claude ready\n> ");

let awaitingPermission = false;
for await (const line of console) {
	const text = line.trim();
	if (text === "exit") {
		fire("SessionEnd", { reason: "prompt_input_exit" });
		process.exit(0);
	}
	if (awaitingPermission) {
		awaitingPermission = false;
		fire("PostToolUse", { tool_name: "Bash" });
		fire("Stop", { last_assistant_message: "Ran it." });
	} else {
		fire("UserPromptSubmit", { prompt: text });
		if (text.includes("permission")) {
			awaitingPermission = true;
			fire("Notification", {
				notification_type: "permission_prompt",
				message: "Claude needs your permission to use Bash",
			});
		} else {
			fire("Stop", { last_assistant_message: `Done: ${text}` });
		}
	}
	process.stdout.write(`got: ${text}\n> `);
}

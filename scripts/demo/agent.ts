#!/usr/bin/env bun
/**
 * A stand-in for `claude` in the README demo (scripts/demo/README.md), like
 * e2e/fake-claude.ts but playing the scenario in scenario.ts.
 *
 * Interactive (an agent session): fires Claude Code's hooks from `--settings`.
 * The prompt after `--` starts it working. Lines typed into its pane (by
 * demo.ts) move it on:
 *   pause <text>       → Stop with <text> as its reply (it goes idle)
 *   resume             → UserPromptSubmit: working again
 *   permission <cmd>   → a permission prompt for Bash <cmd>
 *   ask <question>     → Stop with the question as its reply
 *   any other line     → a prompt from the user: working again, and for a
 *                        session with an `answer`, that reply 2.5 s later
 * On a permission prompt, "1" or Enter approves it and it carries on working.
 *
 * `-p --json-schema` (the master's workers): summaries and topics from the
 * scenario, suggestions for waiting sessions, the Slack inbox from the JSON
 * file at SERENITY_FAKE_SLACK, and the scenario's Slack follow-ups.
 *
 * `-p --input-format stream-json` (the master chat): the scenario's CHAT turn
 * for the message, calling its serenity tools through the daemon as the real
 * master does over MCP; "Heard: <text>" for anything else.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { connectDaemon } from "../../packages/core/src/index";
import {
	CHAT,
	LATER_SESSIONS,
	SESSIONS,
	sessionIn,
	TIMELINE,
} from "./scenario";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const at = args.indexOf(name);
	return at === -1 ? undefined : args[at + 1];
};
const emit = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

if (args.includes("--version")) {
	console.log("0.0.0 (serenity demo claude)");
	process.exit(0);
}

if (args.includes("-p") && flag("--json-schema")) {
	const prompt = await Bun.stdin.text();
	emit({
		type: "result",
		is_error: false,
		structured_output: answer(prompt, flag("--json-schema") as string),
	});
	process.exit(0);
}

if (args.includes("-p") && flag("--input-format") === "stream-json") {
	await chat();
	process.exit(0);
}

await interactive();

// ------------------------------------------------------------------ workers

function answer(prompt: string, schema: string): unknown {
	const line = (label: string) =>
		prompt
			.split("\n")
			.find((l) => l.startsWith(label))
			?.slice(label.length)
			.trim() ?? "";

	// The Slack inbox.
	if (schema.includes('"access"')) {
		let items: unknown = [];
		try {
			const fixture = process.env.SERENITY_FAKE_SLACK;
			if (fixture) items = JSON.parse(readFileSync(fixture, "utf8"));
		} catch {}
		return { access: "ok", problem: null, items };
	}

	// A Slack follow-up: the scenario's, for the message in the prompt.
	if (schema.includes('"tell"')) {
		const text = prompt.match(/^\S+ wrote: (.*)$/m)?.[1] ?? "";
		for (const event of TIMELINE) {
			if (event.kind !== "slack" || event.item.text !== text) continue;
			const s = event.item.suggestion;
			if (s.kind === "tell" && prompt.includes("It answered:"))
				return { kind: "reply", text: s.reply, session: s.session, name: null };
			return s.kind === "reply"
				? { kind: "reply", text: s.text, session: null, name: null }
				: { kind: "tell", text: s.text, session: s.session, name: null };
		}
		return { kind: "none", text: null, session: null, name: null };
	}

	// A session's summary and topic.
	if (schema.includes('"finished"')) {
		const session = sessionIn(prompt);
		const reply = line("The agent's last reply:");
		const finished = reply.startsWith("Done:");
		const done = reply.slice("Done:".length).trim();
		const ask = reply.endsWith("?") ? reply : null;
		return {
			summary: finished ? done.charAt(0).toUpperCase() + done.slice(1) : reply,
			ask,
			finished,
			topic: session?.topic ?? "misc",
		};
	}

	// A suggestion for a session that needs the user.
	if (prompt.includes("waiting on permission"))
		return { kind: "approve", label: "Approve: run the migration", text: null };
	if (prompt.includes("waiting on question"))
		return { kind: "reply", label: 'Reply "cents"', text: "cents" };
	return { kind: "none", label: "nothing", text: null };
}

// --------------------------------------------------------------------- chat

async function chat(): Promise<void> {
	const sessionId = `demo-chat-${process.pid}`;
	emit({ type: "system", subtype: "init", session_id: sessionId });
	const home = process.env.SERENITY_HOME;
	const daemon = home ? await connectDaemon(home) : null;
	for await (const raw of console) {
		if (!raw.trim()) continue;
		const message = JSON.parse(raw) as { message: { content: string } };
		const body = message.message.content;
		// The user's words sit after "User: ", before any notes from serenity.
		const user = body.match(/\nUser: ([\s\S]*?)(?:\n\nserenity: |$)/)?.[1];
		const turn = CHAT.find((t) => t.when.test(user?.trim() ?? body));
		// A moment of thinking, as the real chat takes.
		await Bun.sleep(1_200);
		for (const tool of turn?.tools ?? [])
			await daemon?.request("master.tool", {
				repo: process.cwd(),
				name: tool.name,
				args: tool.args,
			});
		const reply = turn?.reply ?? `Heard: ${user?.trim() ?? body}`;
		emit({
			type: "assistant",
			session_id: sessionId,
			message: { content: [{ type: "text", text: reply }] },
		});
		emit({
			type: "result",
			subtype: "success",
			session_id: sessionId,
			is_error: false,
			result: reply,
		});
	}
}

// -------------------------------------------------------------- interactive

async function interactive(): Promise<void> {
	const settingsPath = flag("--settings");
	const settings = settingsPath
		? JSON.parse(readFileSync(settingsPath, "utf8"))
		: { hooks: {} };
	const sessionId = flag("--resume") ?? `demo-${process.pid}`;
	const scripted = [...SESSIONS, ...LATER_SESSIONS].find((s) =>
		process.cwd().endsWith(`-${s.name}`),
	);
	const name = scripted?.name;

	const fire = (event: string, extra: Record<string, unknown> = {}) => {
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
	};

	/** Claude refreshes its status line after a reply: this feeds the usage bar. */
	const statusLine = () => {
		const command = settings.statusLine?.command;
		if (!command) return;
		spawnSync("sh", ["-c", command], {
			input: JSON.stringify({
				session_id: sessionId,
				cwd: process.cwd(),
				rate_limits: {
					five_hour: { used_percentage: 38, resets_at: 4_102_444_800 },
					seven_day: { used_percentage: 21, resets_at: 4_102_444_800 },
				},
			}),
			stdio: ["pipe", "ignore", "inherit"],
		});
	};

	const say = (text: string) => process.stdout.write(`${text}\r\n`);
	const work = (prompt: string) => {
		fire("UserPromptSubmit", { prompt });
		say(`> ${prompt}`);
		say("● Working…");
	};
	const stop = (reply: string) => {
		fire("Stop", { last_assistant_message: reply });
		statusLine();
		say(reply);
	};

	fire("SessionStart", { source: "startup" });
	say(`demo claude · ${name ?? "session"}`);
	const dashes = args.indexOf("--");
	const brief = dashes === -1 ? undefined : args[dashes + 1];
	if (brief) work(brief);

	let onPermission = false;
	const approve = () => {
		onPermission = false;
		fire("PostToolUse", { tool_name: "Bash" });
		say("● Running…");
	};

	const onLine = (raw: string) => {
		const text = raw.trim();
		if (onPermission) return approve();
		const [command = "", ...rest] = text.split(" ");
		const arg = rest.join(" ");
		if (command === "pause") stop(arg);
		else if (command === "resume") work("Carry on");
		else if (command === "ask") stop(arg);
		else if (command === "permission") {
			onPermission = true;
			fire("PermissionRequest", {
				tool_name: "Bash",
				tool_input: { command: arg },
			});
			say(
				` Bash command\r\n   ${arg}\r\n Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No`,
			);
		} else if (command === "exit") {
			fire("SessionEnd", { reason: "prompt_input_exit" });
			process.exit(0);
		} else if (text) {
			work(text);
			const answer = scripted?.answer;
			if (answer) setTimeout(() => stop(answer), 2_500);
		}
	};

	process.stdin.setRawMode?.(true);
	let buffer = "";
	for await (const chunk of process.stdin) {
		for (const ch of chunk.toString()) {
			if (onPermission && ch === "1") approve();
			else if (ch === "\r" || ch === "\n") {
				const done = buffer;
				buffer = "";
				onLine(done);
			} else if (ch === "\u0003") process.exit(130);
			else buffer += ch;
		}
	}
}

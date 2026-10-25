#!/usr/bin/env bun
/**
 * A stand-in for `claude` in E2E tests (ADR 0013), in three modes.
 *
 * Interactive (an agent session): reads the hooks from `--settings` and fires
 * them the way Claude Code would. Input is read key by key:
 *   a line            → UserPromptSubmit, then Stop ("Done: <line>")
 *   a line with "?"   → UserPromptSubmit, then Stop ("Should I <line>")
 *   a line with "permission" → UserPromptSubmit, then a permission prompt:
 *                       the key "1" (or any line) → PostToolUse, then Stop
 *   "crash"           → exit 3 with no hook, like a crash
 *   "exit"            → SessionEnd, then exit
 *   In a folder whose name ends in "-untrusted" it first asks to trust the
 *   folder and fires no hooks until the answer is "y".
 *   Like Claude Code, with CLAUDE_CONFIG_DIR set and inside tmux it keeps
 *   `sessions/<pid>.json` (status, pane) and a transcript current, which is
 *   what serenity reads for sessions it adopted (ADR 0016). `--resume <id>`
 *   continues that session id.
 *
 * `-p --json-schema` (the master's Haiku/Sonnet workers): answers the summary
 * or suggestion schema from the prompt on stdin.
 *
 * `-p --input-format stream-json` (the master chat): replies "Heard: <text>".
 * "suggest a reply to <name>" calls serenity's MCP `suggest` tool and "ask
 * permission" its permission tool, through the real `serenity mcp` proxy.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const at = args.indexOf(name);
	return at === -1 ? undefined : args[at + 1];
};
const emit = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

if (args.includes("--version")) {
	console.log("0.0.0 (fake claude)");
	process.exit(0);
}

if (args.includes("-p") && flag("--json-schema")) {
	const prompt = await Bun.stdin.text();
	emit({
		type: "result",
		is_error: false,
		structured_output: answerSchema(prompt, flag("--json-schema") as string),
	});
	process.exit(0);
}

if (args.includes("-p") && flag("--input-format") === "stream-json") {
	await chat();
	process.exit(0);
}

await interactive();

// ------------------------------------------------------------------ workers

function answerSchema(prompt: string, schema: string): unknown {
	const line = (label: string) =>
		prompt
			.split("\n")
			.find((l) => l.startsWith(label))
			?.slice(label.length)
			.trim() ?? "";
	if (schema.includes('"finished"')) {
		const reply = line("The agent's last reply:");
		return {
			summary: `Summary: ${reply}`,
			ask: reply.includes("?") ? reply : null,
			finished: reply.startsWith("Done"),
			category: "backend",
		};
	}
	if (prompt.includes("waiting on permission"))
		return { kind: "approve", label: "Approve: run it", text: null };
	if (prompt.includes("waiting on question"))
		return { kind: "reply", label: 'Reply "yes"', text: "yes" };
	if (line("Status:").startsWith("done"))
		return { kind: "cleanup", label: "Clean up the worktree", text: null };
	return { kind: "none", label: "nothing", text: null };
}

// --------------------------------------------------------------------- chat

async function chat(): Promise<void> {
	const sessionId = `fake-chat-${process.pid}`;
	const mcp = startMcp(flag("--mcp-config"));
	emit({ type: "system", subtype: "init", session_id: sessionId });
	for await (const line of console) {
		if (!line.trim()) continue;
		const message = JSON.parse(line) as { message: { content: string } };
		const text = message.message.content.split("User: ").pop()?.trim() ?? "";
		let reply = `Heard: ${text}`;
		const target = text.match(/suggest a reply to (\S+)/)?.[1];
		if (target && mcp) {
			const result = await mcp.call("suggest", {
				session: target,
				kind: "reply",
				label: 'Reply "ok"',
				text: "ok",
			});
			reply = `Suggested. ${result}`;
		} else if (text.includes("ask permission") && mcp) {
			const result = await mcp.call("request_permission", {
				tool_name: "Bash",
				input: { command: "npm test" },
				tool_use_id: "t1",
			});
			reply = `Permission: ${JSON.parse(result).behavior}`;
		}
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
	mcp?.stop();
}

/** Starts the MCP server named in --mcp-config and calls its tools. */
function startMcp(config: string | undefined) {
	if (!config) return null;
	const server = JSON.parse(config).mcpServers.serenity as {
		command: string;
		args: string[];
		env: Record<string, string>;
	};
	const child: ChildProcess = spawn(server.command, server.args, {
		env: { ...process.env, ...server.env },
		stdio: ["pipe", "pipe", "inherit"],
	});
	const waiting = new Map<number, (text: string) => void>();
	let buffer = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
			const msg = JSON.parse(buffer.slice(0, at));
			buffer = buffer.slice(at + 1);
			waiting.get(msg.id)?.(
				msg.result?.content?.[0]?.text ?? JSON.stringify(msg.result),
			);
			waiting.delete(msg.id);
		}
	});
	let id = 0;
	const request = (method: string, params: unknown) =>
		new Promise<string>((resolve) => {
			id++;
			waiting.set(id, resolve);
			child.stdin?.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
		});
	const ready = request("initialize", { protocolVersion: "2025-06-18" });
	return {
		call: async (name: string, toolArgs: unknown) => {
			await ready;
			return request("tools/call", { name, arguments: toolArgs });
		},
		stop: () => child.kill(),
	};
}

// -------------------------------------------------------------- interactive

async function interactive(): Promise<void> {
	const settingsPath = flag("--settings");
	const settings = settingsPath
		? JSON.parse(readFileSync(settingsPath, "utf8"))
		: { hooks: {} };
	const sessionId = flag("--resume") ?? `fake-${process.pid}`;
	const registry = claudeRegistry(sessionId);

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

	let state: "trust" | "ready" | "permission" = process
		.cwd()
		.endsWith("-untrusted")
		? "trust"
		: "ready";
	const start = () => {
		state = "ready";
		registry.status("idle");
		fire("SessionStart", { source: "startup" });
		process.stdout.write("fake claude ready\r\n> ");
	};
	if (state === "trust")
		process.stdout.write("Do you trust this folder? (y/n) ");
	else start();

	const approve = () => {
		state = "ready";
		fire("PostToolUse", { tool_name: "Bash" });
		registry.reply("Ran it.");
		fire("Stop", { last_assistant_message: "Ran it." });
		process.stdout.write("approved\r\n> ");
	};

	const onLine = (raw: string) => {
		const text = raw.trim();
		if (state === "trust") {
			if (text !== "y") process.exit(0);
			return start();
		}
		if (state === "permission") return approve();
		if (text === "crash") process.exit(3);
		if (text === "exit") {
			fire("SessionEnd", { reason: "prompt_input_exit" });
			process.exit(0);
		}
		fire("UserPromptSubmit", { prompt: text });
		registry.prompt(text);
		if (text.includes("permission")) {
			state = "permission";
			fire("PermissionRequest", {
				tool_name: "Bash",
				tool_input: { command: "touch x" },
			});
			process.stdout.write(
				"\r\n Bash command\r\n   touch x\r\n Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n",
			);
			registry.status("waiting", "dialog open");
			return;
		}
		const reply = text.includes("?") ? `Should I ${text}` : `Done: ${text}`;
		registry.reply(reply);
		fire("Stop", { last_assistant_message: reply });
		process.stdout.write(`got: ${text}\r\n> `);
	};

	// Key by key, like Claude Code: a lone "1" answers the permission menu.
	process.stdin.setRawMode?.(true);
	// Read through a function: the handlers above change `state` as keys arrive.
	const current = (): typeof state => state;
	let line = "";
	for await (const chunk of process.stdin) {
		for (const ch of chunk.toString()) {
			if (current() === "permission" && ch === "1") {
				approve();
			} else if (ch === "\r" || ch === "\n") {
				const done = line;
				line = "";
				onLine(done);
			} else if (ch === "\u0003") {
				process.exit(130);
			} else {
				line += ch;
			}
		}
	}
}

/**
 * Claude Code's own bookkeeping: `<config>/sessions/<pid>.json` and the
 * transcript. A no-op outside tmux or without CLAUDE_CONFIG_DIR.
 */
function claudeRegistry(sessionId: string) {
	const config = process.env.CLAUDE_CONFIG_DIR;
	const pane = process.env.TMUX_PANE;
	const where =
		config && pane
			? spawnSync(
					"tmux",
					[
						"display-message",
						"-p",
						"-t",
						pane,
						"#{session_name}:#{window_id}.#{pane_id}",
					],
					{ encoding: "utf8" },
				).stdout.trim()
			: "";
	if (!config || !where)
		return { status: () => {}, prompt: () => {}, reply: () => {} };
	const cwd = process.cwd();
	const file = join(config, "sessions", `${process.pid}.json`);
	const transcript = join(
		config,
		"projects",
		cwd.replace(/[^a-zA-Z0-9]/g, "-"),
		`${sessionId}.jsonl`,
	);
	mkdirSync(dirname(file), { recursive: true });
	mkdirSync(dirname(transcript), { recursive: true });
	process.on("exit", () => rmSync(file, { force: true }));
	const log = (entry: object) =>
		appendFileSync(transcript, `${JSON.stringify(entry)}\n`);
	const status = (value: string, waitingFor?: string) =>
		writeFileSync(
			file,
			JSON.stringify({
				pid: process.pid,
				sessionId,
				cwd,
				kind: "interactive",
				tmux: where,
				status: value,
				waitingFor,
			}),
		);
	return {
		status,
		prompt: (text: string) => {
			log({ type: "last-prompt", lastPrompt: text });
			status("busy");
		},
		reply: (text: string) => {
			log({
				type: "assistant",
				message: { content: [{ type: "text", text }] },
			});
			status("idle");
		},
	};
}

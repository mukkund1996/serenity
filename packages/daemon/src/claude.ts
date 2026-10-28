import { MASTER_SKILL, SLACK_SEND_TOOL } from "@serenity/core";

/**
 * Runs the master's `claude -p` processes (ADR 0007), through the user's own
 * logged-in CLI. Behind an interface so the supervisor can be tested with a fake.
 */

export interface JsonRunOptions {
	prompt: string;
	model: string;
	schema: object;
	cwd: string;
	/** MCP servers for this call (`--mcp-config` JSON); none by default. */
	mcpConfig?: string;
	/** MCP tools it may call; every other tool is denied. */
	allowedTools?: string[];
	timeoutMs?: number;
}

export interface ChatOptions {
	cwd: string;
	model: string;
	mcpConfigPath: string;
	/** Plugin with the master's skill, loaded with `--plugin-dir`. */
	pluginDir: string;
	/** Tools allowed beyond CHAT_ALLOWED, e.g. Slack's read tools. */
	extraAllowed?: string[];
	systemPrompt: string;
	/** Claude session id to continue after a restart. */
	resume: string | null;
}

export type ChatEvent =
	| { type: "session"; sessionId: string }
	| { type: "text"; text: string }
	| { type: "result"; isError: boolean; text: string }
	| { type: "exit"; code: number | null; stderr: string };

export interface ChatProcess {
	send(text: string): void;
	stop(): void;
}

export interface ClaudeRunner {
	/** One-shot call returning `structured_output`; throws if there is none. */
	runJson(opts: JsonRunOptions): Promise<unknown>;
	startChat(
		opts: ChatOptions,
		onEvent: (event: ChatEvent) => void,
	): ChatProcess;
}

/** Built-in tools the chat may use, and the subset that never asks (ADR 0008). */
const CHAT_TOOLS = "Read,Grep,Glob,Bash,Skill";
const CHAT_ALLOWED = [
	"Read",
	"Grep",
	"Glob",
	`Skill(${MASTER_SKILL})`,
	"Bash(git log *)",
	"Bash(git diff *)",
	"Bash(git status *)",
	"Bash(git show *)",
	"Bash(git branch *)",
	"Bash(gh pr view *)",
	"Bash(gh pr list *)",
	"mcp__serenity__suggest",
	"mcp__serenity__send_reply",
	"mcp__serenity__set_topic",
	"mcp__serenity__archive_session",
	"mcp__serenity__open_session",
	"mcp__serenity__session_status",
	"mcp__serenity__watch_session",
	"mcp__serenity__create_session",
].join(",");
export const PERMISSION_TOOL = "mcp__serenity__request_permission";
/** Posting to Slack always reaches PERMISSION_TOOL, never the auto-mode classifier (ADR 0030). */
const CHAT_SETTINGS = JSON.stringify({
	permissions: { ask: [SLACK_SEND_TOOL] },
});

const JSON_TIMEOUT_MS = 120_000;

/**
 * Keeps the user's hooks, plugins and MCP servers out of the master's
 * processes; authentication still comes from their login.
 */
const ISOLATION = ["--strict-mcp-config", "--setting-sources", ""];

export class CliClaudeRunner implements ClaudeRunner {
	constructor(private readonly claude: string[]) {}

	async runJson(opts: JsonRunOptions): Promise<unknown> {
		const proc = Bun.spawn(
			[
				...this.claude,
				"-p",
				"--output-format",
				"json",
				"--json-schema",
				JSON.stringify(opts.schema),
				"--model",
				opts.model,
				"--tools",
				"",
				"--no-session-persistence",
				...ISOLATION,
				...(opts.mcpConfig ? ["--mcp-config", opts.mcpConfig] : []),
				...(opts.allowedTools?.length
					? ["--allowedTools", opts.allowedTools.join(",")]
					: []),
			],
			{
				cwd: opts.cwd,
				stdin: new TextEncoder().encode(opts.prompt),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const timer = setTimeout(
			() => proc.kill(),
			opts.timeoutMs ?? JSON_TIMEOUT_MS,
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		clearTimeout(timer);
		let parsed: {
			structured_output?: unknown;
			is_error?: boolean;
			result?: string;
		};
		try {
			parsed = JSON.parse(stdout);
		} catch {
			throw new Error(
				`claude exited ${code}: ${(stderr || stdout).trim().slice(0, 200)}`,
			);
		}
		if (parsed.is_error || parsed.structured_output === undefined)
			throw new Error(
				`no structured output: ${String(parsed.result ?? stderr).slice(0, 200)}`,
			);
		return parsed.structured_output;
	}

	startChat(
		opts: ChatOptions,
		onEvent: (event: ChatEvent) => void,
	): ChatProcess {
		const proc = Bun.spawn(
			[
				...this.claude,
				"-p",
				"--input-format",
				"stream-json",
				"--output-format",
				"stream-json",
				"--verbose",
				"--model",
				opts.model,
				"--tools",
				CHAT_TOOLS,
				"--allowedTools",
				[CHAT_ALLOWED, ...(opts.extraAllowed ?? [])].join(","),
				"--mcp-config",
				opts.mcpConfigPath,
				"--permission-mode",
				"auto",
				"--permission-prompt-tool",
				PERMISSION_TOOL,
				"--settings",
				CHAT_SETTINGS,
				"--plugin-dir",
				opts.pluginDir,
				"--append-system-prompt",
				opts.systemPrompt,
				...ISOLATION,
				...(opts.resume ? ["--resume", opts.resume] : []),
			],
			{ cwd: opts.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		void readLines(proc.stdout, (line) => {
			for (const event of parseChatLine(line)) onEvent(event);
		});
		const stderr = new Response(proc.stderr).text();
		void proc.exited.then(async (code) =>
			onEvent({
				type: "exit",
				code,
				stderr: (await stderr).trim().slice(-300),
			}),
		);
		return {
			send: (text) => {
				proc.stdin.write(
					`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`,
				);
				proc.stdin.flush();
			},
			stop: () => {
				proc.stdin.end();
				proc.kill();
			},
		};
	}
}

/** Turns one stream-json line into the events the supervisor cares about. */
export function parseChatLine(line: string): ChatEvent[] {
	let msg: {
		type?: string;
		subtype?: string;
		session_id?: string;
		is_error?: boolean;
		result?: string;
		message?: { content?: Array<{ type: string; text?: string }> };
	};
	try {
		msg = JSON.parse(line);
	} catch {
		return [];
	}
	if (msg.type === "system" && msg.subtype === "init" && msg.session_id)
		return [{ type: "session", sessionId: msg.session_id }];
	if (msg.type === "assistant")
		return (msg.message?.content ?? [])
			.filter((block) => block.type === "text" && block.text?.trim())
			.map((block) => ({ type: "text", text: (block.text as string).trim() }));
	if (msg.type === "result")
		return [
			{ type: "result", isError: !!msg.is_error, text: msg.result ?? "" },
		];
	return [];
}

async function readLines(
	stream: ReadableStream<Uint8Array>,
	onLine: (line: string) => void,
): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) onLine(line);
			newline = buffer.indexOf("\n");
		}
	}
	if (buffer.trim()) onLine(buffer.trim());
}

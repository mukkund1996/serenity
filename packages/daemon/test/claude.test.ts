import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatEvent,
	CliClaudeRunner,
	EXIT_DRAIN_MS,
	parseChatLine,
} from "../src/claude";

/** Stands in for `claude`: a shell script that reads one message, then does `body`. */
let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "srclaude-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function fakeClaude(body: string): CliClaudeRunner {
	const path = join(tmp, "claude");
	writeFileSync(path, `#!/bin/sh\nread line\n${body}\n`);
	chmodSync(path, 0o755);
	return new CliClaudeRunner([path]);
}

/** Starts a chat, sends one message, and resolves with its events once it exits. */
function run(runner: CliClaudeRunner, onEvent?: (e: ChatEvent) => void) {
	const events: ChatEvent[] = [];
	const started = Date.now();
	const exited = new Promise<{ events: ChatEvent[]; ms: number }>((resolve) => {
		const chat = runner.startChat(
			{
				cwd: tmp,
				model: "opus",
				mcpConfigPath: "{}",
				pluginDir: tmp,
				systemPrompt: "",
				resume: null,
			},
			(event) => {
				events.push(event);
				onEvent?.(event);
				if (event.type === "exit")
					resolve({ events, ms: Date.now() - started });
			},
		);
		chat.send("hi");
	});
	return exited;
}

const RESULT = '{"type":"result","is_error":false,"result":"done"}';

describe("the chat process (issue #106)", () => {
	test("its exit is reported even while a child it left holds stdout and stderr open", async () => {
		// As claude's MCP server waiting on a permission request, or a Bash
		// command left running, does after claude itself has gone.
		const { events, ms } = await run(
			fakeClaude(`echo '${RESULT}'\n( sleep 30 ) &\nexit 3`),
		);
		expect(events.map((e) => e.type)).toEqual(["result", "exit"]);
		expect(events.at(-1)).toMatchObject({ code: 3 });
		expect(ms).toBeLessThan(EXIT_DRAIN_MS + 2_000);
	});

	test("a result printed just before it exits comes before the exit", async () => {
		const lines = Array.from(
			{ length: 500 },
			() => `echo '{"type":"user"}'`,
		).join("\n");
		const { events } = await run(fakeClaude(`${lines}\necho '${RESULT}'`));
		expect(events.at(-2)).toEqual({
			type: "result",
			isError: false,
			text: "done",
		});
		expect(events.at(-1)?.type).toBe("exit");
	});

	test("a handler that throws does not stop the lines after it", async () => {
		let first = true;
		const { events } = await run(
			fakeClaude(`echo '{"type":"user"}'\necho '${RESULT}'`),
			() => {
				if (first) {
					first = false;
					throw new Error("boom");
				}
			},
		);
		expect(events.map((e) => e.type)).toEqual(["activity", "result", "exit"]);
	});

	test("sending to a chat whose process has exited throws instead of losing the message", async () => {
		const runner = fakeClaude("exit 0");
		let chat: ReturnType<CliClaudeRunner["startChat"]> | undefined;
		await new Promise<void>((resolve) => {
			chat = runner.startChat(
				{
					cwd: tmp,
					model: "opus",
					mcpConfigPath: "{}",
					pluginDir: tmp,
					systemPrompt: "",
					resume: null,
				},
				(event) => {
					if (event.type === "exit") resolve();
				},
			);
			chat.send("hi");
		});
		expect(() => chat?.send("again")).toThrow("claude has exited");
	});
});

describe("parseChatLine", () => {
	test("an error result without text says what kind of error it was", () => {
		expect(
			parseChatLine(
				'{"type":"result","subtype":"error_max_turns","is_error":true}',
			),
		).toEqual([{ type: "result", isError: true, text: "error_max_turns" }]);
		expect(
			parseChatLine(
				'{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["API overloaded"]}',
			),
		).toEqual([{ type: "result", isError: true, text: "API overloaded" }]);
	});

	test("a reply's text is shown, and any other line counts as activity", () => {
		expect(
			parseChatLine(
				'{"type":"assistant","message":{"content":[{"type":"text","text":" Hi "}]}}',
			),
		).toEqual([{ type: "text", text: "Hi" }]);
		expect(parseChatLine('{"type":"system","subtype":"api_retry"}')).toEqual([
			{ type: "activity" },
		]);
		expect(parseChatLine("not json")).toEqual([]);
	});
});

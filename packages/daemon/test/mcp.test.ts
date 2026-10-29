import { describe, expect, test } from "bun:test";
import { RpcError, RpcErrorCode, type RpcPeer } from "@serenity/core";
import { forwardTool, handleMcpMessage } from "../src/mcp";

const call = async (name: string, args: Record<string, unknown>) => ({
	text: `${name}:${JSON.stringify(args)}`,
});

test("initialize echoes the protocol version and declares tools", async () => {
	const out = (await handleMcpMessage(
		{
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18" },
		},
		call,
	)) as { result: { protocolVersion: string; capabilities: object } };
	expect(out.result.protocolVersion).toBe("2025-06-18");
	expect(out.result.capabilities).toEqual({ tools: {} });
});

test("tools/list names serenity's three tools", async () => {
	const out = (await handleMcpMessage(
		{ jsonrpc: "2.0", id: 2, method: "tools/list" },
		call,
	)) as {
		result: { tools: Array<{ name: string }> };
	};
	expect(out.result.tools.map((t) => t.name)).toEqual([
		"suggest",
		"send_reply",
		"set_topic",
		"archive_session",
		"open_session",
		"session_status",
		"watch_session",
		"create_session",
		"request_permission",
	]);
});

test("tools/call forwards to the daemon and wraps the answer; failures become tool errors", async () => {
	const ok = await handleMcpMessage(
		{
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "suggest", arguments: { session: "a" } },
		},
		call,
	);
	expect(ok).toEqual({
		jsonrpc: "2.0",
		id: 3,
		result: {
			content: [{ type: "text", text: 'suggest:{"session":"a"}' }],
			isError: false,
		},
	});
	const failed = (await handleMcpMessage(
		{
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: { name: "x", arguments: {} },
		},
		async () => {
			throw new Error("down");
		},
	)) as { result: { isError: boolean; content: Array<{ text: string }> } };
	expect(failed.result.isError).toBe(true);
	expect(failed.result.content[0]?.text).toContain("down");
});

test("notifications get no reply; unknown methods get an error", async () => {
	expect(
		await handleMcpMessage(
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			call,
		),
	).toBeNull();
	expect(
		await handleMcpMessage(
			{ jsonrpc: "2.0", id: 5, method: "resources/list" },
			call,
		),
	).toMatchObject({
		error: { code: -32601 },
	});
});

test("tools/call with arguments that are not an object is invalid params", async () => {
	const out = await handleMcpMessage(
		{
			jsonrpc: "2.0",
			id: 9,
			method: "tools/call",
			params: { name: "suggest", arguments: "oops" },
		},
		call,
	);
	expect(out).toMatchObject({ id: 9, error: { code: -32602 } });
});

describe("forwardTool", () => {
	const NO_WAIT = [0, 0, 0];
	/** Connections that answer in turn: null (unreachable), an error, or a result. */
	const connections = (...answers: Array<null | Error | object>) => {
		let calls = 0;
		const connect = async () => {
			calls++;
			const answer = answers.shift();
			if (answer === null || answer === undefined) return null;
			return {
				request: async () => {
					if (answer instanceof Error) throw answer;
					return answer;
				},
				close: () => {},
			} as unknown as Pick<RpcPeer, "request" | "close">;
		};
		return { connect, calls: () => calls };
	};
	const lost = () => new RpcError(RpcErrorCode.Closed, "connection closed");

	test("retries reaching a daemon that is not up yet", async () => {
		const c = connections(null, null, { text: "ok" });
		expect(await forwardTool(c.connect, "/r", "suggest", {}, NO_WAIT)).toEqual({
			text: "ok",
		});
		expect(c.calls()).toBe(3);
	});

	test("gives up once the retries are spent", async () => {
		const c = connections(null, null, null, null, { text: "late" });
		expect(await forwardTool(c.connect, "/r", "suggest", {}, NO_WAIT)).toEqual({
			text: "serenity's daemon is not running.",
			isError: true,
		});
	});

	test("a connection lost mid-call is retried only for a read-only tool", async () => {
		const read = connections(lost(), { text: "status" });
		expect(
			await forwardTool(read.connect, "/r", "session_status", {}, NO_WAIT),
		).toEqual({ text: "status" });
		const write = connections(lost(), { text: "twice" });
		await expect(
			forwardTool(write.connect, "/r", "create_session", {}, NO_WAIT),
		).rejects.toThrow("connection closed");
		expect(write.calls()).toBe(1);
	});
});

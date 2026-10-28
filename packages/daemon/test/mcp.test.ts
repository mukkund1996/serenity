import { expect, test } from "bun:test";
import { handleMcpMessage } from "../src/mcp";

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

import { connectDaemon, type MasterToolResult } from "@serenity/core";

/**
 * `serenity mcp <repo>` (ADR 0008): the MCP stdio server that the master
 * chat's `claude` starts. It speaks just enough MCP to list serenity's tools
 * and forwards each call to the daemon over the socket.
 */

export const MCP_TOOLS = [
	{
		name: "suggest",
		description:
			"Propose one action for a session. The user sees it in NEEDS YOU and it runs only if they press y. kind: reply (send text to the agent), approve (accept its permission prompt), cleanup (stop it and remove its worktree, after its PR merged) or review (ask the GitHub login in text to review its open PR).",
		inputSchema: {
			type: "object",
			properties: {
				session: { type: "string", description: "Session name" },
				kind: {
					type: "string",
					enum: ["reply", "approve", "cleanup", "review"],
				},
				label: {
					type: "string",
					description:
						'Short imperative label, e.g. Reply "yes, set it to 15m"',
				},
				text: { type: "string", description: "Reply text; replies only" },
			},
			required: ["session", "kind", "label"],
		},
	},
	{
		name: "set_topic",
		description:
			"Move a session to another topic. Use only when the user asks.",
		inputSchema: {
			type: "object",
			properties: {
				session: { type: "string" },
				topic: { type: "string" },
			},
			required: ["session", "topic"],
		},
	},
	{
		name: "request_permission",
		description: "Asks the user in serenity whether a tool call may run.",
		inputSchema: {
			type: "object",
			properties: {
				tool_name: { type: "string" },
				input: { type: "object" },
				tool_use_id: { type: "string" },
			},
			required: ["tool_name", "input"],
		},
	},
] as const;

type Message = {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
};
type CallTool = (
	name: string,
	args: Record<string, unknown>,
) => Promise<MasterToolResult>;

/** The reply to one MCP message, or null for notifications. */
export async function handleMcpMessage(
	msg: Message,
	callTool: CallTool,
): Promise<object | null> {
	if (msg.id === undefined) return null;
	const reply = (result: object) => ({ jsonrpc: "2.0", id: msg.id, result });
	switch (msg.method) {
		case "initialize":
			return reply({
				protocolVersion:
					(msg.params?.protocolVersion as string) ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "serenity", version: "1" },
			});
		case "tools/list":
			return reply({ tools: MCP_TOOLS });
		case "tools/call": {
			const name = String(msg.params?.name ?? "");
			const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
			let result: MasterToolResult;
			try {
				result = await callTool(name, args);
			} catch (error) {
				result = {
					text: `serenity: ${error instanceof Error ? error.message : String(error)}`,
					isError: true,
				};
			}
			return reply({
				content: [{ type: "text", text: result.text }],
				isError: !!result.isError,
			});
		}
		case "ping":
			return reply({});
		default:
			return {
				jsonrpc: "2.0",
				id: msg.id,
				error: { code: -32601, message: `unknown method ${msg.method}` },
			};
	}
}

/** The master's permission requests wait for the user, so tool calls may take minutes. */
const TOOL_TIMEOUT_MS = 15 * 60_000;

export async function runMcpProxy(home: string, repo: string): Promise<void> {
	const callTool: CallTool = async (name, args) => {
		const peer = await connectDaemon(home);
		if (!peer)
			return { text: "serenity's daemon is not running.", isError: true };
		try {
			return await peer.request(
				"master.tool",
				{ repo, name, args },
				{ timeoutMs: TOOL_TIMEOUT_MS },
			);
		} finally {
			peer.close();
		}
	};
	const pending: Promise<void>[] = [];
	for await (const line of console) {
		if (!line.trim()) continue;
		let msg: Message;
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}
		// Calls can overlap (a permission request may wait), so answer each when ready.
		pending.push(
			handleMcpMessage(msg, callTool).then((out) => {
				if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
			}),
		);
	}
	await Promise.all(pending);
}

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
		name: "send_reply",
		description:
			"Send text to a session's agent now, as if the user typed it. Only for a reply the user asked for in the chat: their latest message contains the exact text, or your last reply showed it and they confirmed. Anything else is not sent: it waits in NEEDS YOU for y, as suggest kind reply. The session must be live and not on a permission prompt; while it is working, its agent reads the text when its turn ends.",
		inputSchema: {
			type: "object",
			properties: {
				session: { type: "string", description: "Session name" },
				text: {
					type: "string",
					description:
						"The exact text the user asked for or confirmed, character for character",
				},
			},
			required: ["session", "text"],
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
		name: "archive_session",
		description:
			"Kill a session: stop its agent if it is running and archive it, which takes it off the map. Its worktree and branch stay. Use only when the user asks to kill, stop or archive that session.",
		inputSchema: {
			type: "object",
			properties: { session: { type: "string" } },
			required: ["session"],
		},
	},
	{
		name: "open_session",
		description:
			"Open a session's full agent view beside the user's map, as Enter on its card does. Use only when the user asks to open, show or go to a session.",
		inputSchema: {
			type: "object",
			properties: { session: { type: "string" } },
			required: ["session"],
		},
	},
	{
		name: "session_status",
		description:
			"A session's status right now (working, waiting, idle, done, dead, archived), what it waits on, its PR, last prompt and last reply. Without session, every session. The snapshot in the user's message is as old as that message; use this for anything newer.",
		inputSchema: {
			type: "object",
			properties: {
				session: {
					type: "string",
					description: "Session name; leave out for all sessions",
				},
			},
		},
	},
	{
		name: "watch_session",
		description:
			'Hear when a session\'s turn ends, for something to do once it finishes ("tell me when api-auth is done", "post this to Slack when it finishes"). Returns at once; serenity sends you a message when the session stops working: finished, waiting on the user (it stays watched), or ended. One watch per session; a new one replaces it, cancel removes it. slack_text: a Slack message the user has just confirmed in the chat, character for character; it may be sent only once the session finishes.',
		inputSchema: {
			type: "object",
			properties: {
				session: { type: "string" },
				note: {
					type: "string",
					description:
						"What to do when its turn ends, e.g. send the confirmed Slack message to #eng in Dana's thread",
				},
				slack_text: {
					type: "string",
					description:
						"The exact Slack message the user just confirmed, if one goes out when it finishes",
				},
				cancel: { type: "boolean", description: "Stop watching it" },
			},
			required: ["session"],
		},
	},
	{
		name: "create_session",
		description:
			"Start a new session: a Claude Code agent in its own worktree on a new branch off the default base, given prompt as its first message. It starts at once and shows on the map. Use when the user asks to start, spin up or hand off work; call it once per session the brief needs.",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description:
						"Session name, also its branch and worktree: letters, digits, . _ - (max 40), e.g. api-auth",
				},
				prompt: {
					type: "string",
					description:
						"The agent's first message. It sees nothing of this chat, so make it self-contained.",
				},
				topic: {
					type: "string",
					description: "Topic to put it under; optional",
				},
			},
			required: ["name", "prompt"],
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

import { writeFileSync } from "node:fs";
import { HOOK_KINDS } from "@serenity/core";

/** Quotes one argument for /bin/sh. */
export function shellQuote(arg: string): string {
	return /^[\w@%+=:,./-]+$/.test(arg)
		? arg
		: `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * The settings file passed to every spawned session with `claude --settings`
 * (ADR 0006). Each hook runs `serenity hook <Event>`; the user's own settings
 * are untouched. The status line runs `serenity statusline`, which reports
 * plan usage and still prints the user's own status line (ADR 0020).
 */
export function hookSettings(selfCommand: string[]): object {
	const base = selfCommand.map(shellQuote).join(" ");
	const hooks = Object.fromEntries(
		HOOK_KINDS.map((kind) => [
			kind,
			[
				{
					hooks: [
						{ type: "command", command: `${base} hook ${kind}`, timeout: 5 },
					],
				},
			],
		]),
	);
	return {
		hooks,
		statusLine: { type: "command", command: `${base} statusline` },
		// serenity decides itself whether a request waits for the user (ADR 0060).
		permissions: { allow: [AGENT_TOOL_PERMISSION] },
	};
}

/** The agent's request_sessions tool, as Claude Code names it. */
export const AGENT_TOOL_PERMISSION = "mcp__serenity__request_sessions";

/**
 * The `--mcp-config` file of every agent session: `serenity mcp-agent`,
 * which learns the session from SERENITY_SESSION_ID in claude's environment.
 */
export function agentMcpConfig(selfCommand: string[], home: string): object {
	const [command, ...args] = selfCommand;
	return {
		mcpServers: {
			serenity: {
				type: "stdio",
				command,
				args: [...args, "mcp-agent"],
				env: { SERENITY_HOME: home },
			},
		},
	};
}

export function writeAgentMcpConfig(
	path: string,
	selfCommand: string[],
	home: string,
): void {
	writeFileSync(
		path,
		`${JSON.stringify(agentMcpConfig(selfCommand, home), null, 2)}\n`,
	);
}

/** The `$0` of an agent pane's wrapper shell, which marks a pane as serenity's in its start command. */
export const AGENT_WRAPPER = "serenity-agent";

/**
 * The command an agent pane runs: claude under a tiny `sh` parent that tells
 * the daemon when claude exits, for any reason (crash, refused folder trust),
 * which hooks cannot report. Ctrl+C stays with claude: it runs the terminal
 * in raw mode, so the key never becomes a signal to the shell.
 */
export function agentCommand(
	claude: string[],
	settingsPath: string,
	selfCommand: string[],
	/** A first prompt; after `--` so one starting with "-" is not a flag. */
	prompt?: string,
	/**
	 * serenity's MCP server for the session (ADR 0060). Added to the user's
	 * own servers, not in place of them.
	 */
	mcpConfigPath?: string,
): string[] {
	const notify = [...selfCommand, "exited"].map(shellQuote).join(" ");
	return [
		"sh",
		"-c",
		`"$@"; ${notify} "$?"`,
		AGENT_WRAPPER,
		...claude,
		"--settings",
		settingsPath,
		...(mcpConfigPath ? ["--mcp-config", mcpConfigPath] : []),
		...(prompt ? ["--", prompt] : []),
	];
}

export function writeHookSettings(path: string, selfCommand: string[]): void {
	writeFileSync(
		path,
		`${JSON.stringify(hookSettings(selfCommand), null, 2)}\n`,
	);
}

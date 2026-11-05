import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { agentCommand, agentMcpConfig, hookSettings } from "../src/hooks";

test("the agent command runs claude, then reports its exit code", () => {
	const command = agentCommand(["claude"], "/h/hooks.json", [
		"/opt/my bin/serenity",
	]);
	expect(command.slice(0, 2)).toEqual(["sh", "-c"]);
	expect(command[2]).toBe(`"$@"; '/opt/my bin/serenity' exited "$?"`);
	expect(command.slice(4)).toEqual(["claude", "--settings", "/h/hooks.json"]);
});

test("a first prompt follows --, so a leading dash is not read as a flag", () => {
	const command = agentCommand(
		["claude"],
		"/h/hooks.json",
		["serenity"],
		"-v me",
	);
	expect(command.slice(4)).toEqual([
		"claude",
		"--settings",
		"/h/hooks.json",
		"--",
		"-v me",
	]);
});

test("the wrapper passes the exit code through to the notifier", () => {
	// Stand-ins: "claude" exits 7, the notifier echoes its arguments.
	const [sh, flag, script, name, ...rest] = agentCommand(
		["sh", "-c", "exit 7", "x"],
		"s.json",
		["echo"],
	);
	const result = spawnSync(
		sh as string,
		[flag as string, script as string, name as string, ...rest],
		{
			encoding: "utf8",
		},
	);
	expect(result.stdout.trim()).toBe("exited 7");
});

test("serenity's MCP server for the session comes before the first prompt (ADR 0060)", () => {
	const command = agentCommand(
		["claude"],
		"/h/hooks.json",
		["serenity"],
		"go",
		"/h/agent-mcp.json",
	);
	expect(command.slice(4)).toEqual([
		"claude",
		"--settings",
		"/h/hooks.json",
		"--mcp-config",
		"/h/agent-mcp.json",
		"--",
		"go",
	]);
});

test("the hook settings allow request_sessions; the MCP config runs mcp-agent", () => {
	expect(hookSettings(["serenity"])).toMatchObject({
		permissions: { allow: ["mcp__serenity__request_sessions"] },
	});
	expect(agentMcpConfig(["bun", "/src/main.ts"], "/h")).toEqual({
		mcpServers: {
			serenity: {
				type: "stdio",
				command: "bun",
				args: ["/src/main.ts", "mcp-agent"],
				env: { SERENITY_HOME: "/h" },
			},
		},
	});
});

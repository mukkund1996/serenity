import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir } from "@serenity/core";

/** The user's own status line must not hold up Claude's for long. */
const USER_COMMAND_TIMEOUT_MS = 3000;

/** The fields of Claude Code's status line JSON read here. */
export interface StatusLineInput {
	cwd?: string;
	workspace?: { project_dir?: string; current_dir?: string };
	rate_limits?: unknown;
}

function statusLineCommand(path: string): string | null {
	try {
		const settings = JSON.parse(readFileSync(path, "utf8")) as {
			statusLine?: { type?: string; command?: unknown };
		};
		const line = settings.statusLine;
		return line?.type === "command" && typeof line.command === "string"
			? line.command
			: null;
	} catch {
		return null;
	}
}

/**
 * The status line the user configured, which serenity's `--settings`
 * overrides: local, then project, then user settings, as Claude reads them.
 */
export function userStatusLineCommand(
	input: StatusLineInput,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const project = input.workspace?.project_dir ?? input.cwd;
	const paths = [
		...(project
			? [
					join(project, ".claude", "settings.local.json"),
					join(project, ".claude", "settings.json"),
				]
			: []),
		join(claudeConfigDir(env), "settings.json"),
	];
	for (const path of paths) {
		const command = statusLineCommand(path);
		if (command) return command;
	}
	return null;
}

/** Runs the user's status line with Claude's JSON on stdin; its stdout, or "" on failure. */
export async function runUserStatusLine(
	command: string,
	raw: string,
	cwd: string | undefined,
): Promise<string> {
	try {
		const child = Bun.spawn(["sh", "-c", command], {
			cwd,
			stdin: new TextEncoder().encode(raw),
			stdout: "pipe",
			stderr: "ignore",
		});
		const timer = setTimeout(() => child.kill(), USER_COMMAND_TIMEOUT_MS);
		const out = await new Response(child.stdout).text();
		await child.exited;
		clearTimeout(timer);
		return out;
	} catch {
		return "";
	}
}

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
 * are untouched.
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
	return { hooks };
}

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
): string[] {
	const notify = [...selfCommand, "exited"].map(shellQuote).join(" ");
	return [
		"sh",
		"-c",
		`"$@"; ${notify} "$?"`,
		"serenity-agent",
		...claude,
		"--settings",
		settingsPath,
	];
}

export function writeHookSettings(path: string, selfCommand: string[]): void {
	writeFileSync(
		path,
		`${JSON.stringify(hookSettings(selfCommand), null, 2)}\n`,
	);
}

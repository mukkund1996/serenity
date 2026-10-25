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

export function writeHookSettings(path: string, selfCommand: string[]): void {
	writeFileSync(
		path,
		`${JSON.stringify(hookSettings(selfCommand), null, 2)}\n`,
	);
}

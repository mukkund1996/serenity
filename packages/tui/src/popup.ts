import { selfCommand } from "@serenity/core";

/** What a popup command needs from the map's environment: serenity's, gh's and Claude Code's settings. */
const PASS_ENV =
	/^(SERENITY_|XDG_|GH_|CLAUDE_CONFIG_DIR$|PATH$|HOME$|SSH_CONNECTION$)/;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The shell command a popup runs: `serenity <args>`, with the map's
 * environment passed on, since a popup gets tmux's environment, not ours.
 */
export function popupCommand(
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): string {
	const vars = Object.entries(env)
		.filter(([k, v]) => PASS_ENV.test(k) && v !== undefined)
		.map(([k, v]) => `${k}=${quote(v as string)}`);
	return ["env", ...vars, ...[...selfCommand(env), ...args].map(quote)].join(
		" ",
	);
}

/**
 * Runs `serenity <args>` in a tmux popup over the map (ADR 0065) and
 * resolves once it closes. The map keeps running underneath; keys go to
 * the popup. Rejects when tmux can't open one (no attached client).
 */
export async function runInPopup(args: string[], cwd: string): Promise<void> {
	const proc = Bun.spawn(
		[
			"tmux",
			"display-popup",
			"-E",
			"-w",
			"90%",
			"-h",
			"80%",
			"-d",
			cwd,
			popupCommand(args),
		],
		{ stdout: "ignore", stderr: "pipe", stdin: "ignore" },
	);
	const [code, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text(),
	]);
	if (code !== 0 && stderr.trim())
		throw new Error(`tmux couldn't open a popup: ${stderr.trim()}`);
}

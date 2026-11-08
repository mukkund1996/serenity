/**
 * The CLI's error messages: a one-line headline, then what to do about it.
 *
 *   serenity: not inside a git repository
 *     /Users/me/Downloads
 *
 *     serenity opens the map for the repo you are in. Go to one:
 *       cd path/to/your/repo
 *       serenity
 *
 * Colour only on a terminal, and never with NO_COLOR set.
 */

/** A line of explanation, or a command to run with an optional note beside it. */
export type ErrorLine = string | { cmd: string; note?: string };

export interface ErrorMessage {
	/** What went wrong, in a few words. */
	title: string;
	/** Context for the headline, e.g. the directory, printed dim under it. */
	detail?: string;
	/** What to do next. An empty string is a blank line. */
	lines?: ErrorLine[];
	/** The command's name in the headline; "serenity import" for a subcommand. */
	prefix?: string;
}

export function useColor(stream: NodeJS.WriteStream = process.stderr): boolean {
	return Boolean(stream.isTTY) && !process.env.NO_COLOR;
}

export function formatError(msg: ErrorMessage, color = useColor()): string {
	const paint = (code: string, s: string) =>
		color ? `\x1b[${code}m${s}\x1b[0m` : s;
	const prefix = msg.prefix ?? "serenity";
	const out = [`${paint("1;31", `${prefix}:`)} ${paint("1", msg.title)}`];
	if (msg.detail) out.push(`  ${paint("2", msg.detail)}`);
	const lines = msg.lines ?? [];
	if (lines.length) out.push("");
	const width = Math.max(
		0,
		...lines.map((l) => (typeof l === "string" ? 0 : l.cmd.length)),
	);
	for (const line of lines) {
		if (typeof line === "string") out.push(line ? `  ${line}` : "");
		else if (!line.note) out.push(`    ${paint("36", line.cmd)}`);
		else
			out.push(
				`    ${paint("36", line.cmd.padEnd(width))}   ${paint("2", line.note)}`,
			);
	}
	return out.join("\n");
}

export function printError(msg: ErrorMessage): void {
	console.error(formatError(msg));
}

/**
 * Why serenity can't find a repo at `dir`: git is missing, or `dir` is not in
 * one. `command` is what to run again once inside a repo.
 */
export function notInRepo(
	dir: string,
	command: string,
	opts: {
		gitMissing?: boolean;
		prefix?: string;
		alternative?: ErrorLine[];
	} = {},
): ErrorMessage {
	if (opts.gitMissing)
		return {
			prefix: opts.prefix,
			title: "git is not installed",
			lines: [
				"serenity needs git to find your repo. Install it, then check:",
				{ cmd: "serenity doctor", note: "checks git, tmux and claude" },
			],
		};
	return {
		prefix: opts.prefix,
		title: "not inside a git repository",
		detail: dir,
		lines: [
			"Go to a repo and run it again:",
			{ cmd: "cd path/to/your/repo" },
			{ cmd: command },
			"",
			...(opts.alternative ?? [
				"Or make this folder a repo:",
				{ cmd: "git init" },
			]),
		],
	};
}

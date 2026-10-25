export class CommandError extends Error {
	constructor(
		readonly command: string[],
		readonly exitCode: number,
		readonly stderr: string,
	) {
		super(
			`${command.join(" ")} failed (${exitCode}): ${stderr.trim() || "no output"}`,
		);
		this.name = "CommandError";
	}
}

/** Runs a command to completion and returns trimmed stdout; throws CommandError on a non-zero exit. */
export async function run(
	command: string[],
	opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<string> {
	const proc = Bun.spawn(command, {
		cwd: opts.cwd,
		env: opts.env ? { ...process.env, ...opts.env } : process.env,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new CommandError(command, exitCode, stderr);
	return stdout.trim();
}

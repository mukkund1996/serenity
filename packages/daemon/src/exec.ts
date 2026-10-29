import { basename } from "node:path";
import {
	type Dependency,
	isTransientMessage,
	type RetryPolicy,
	withRetry,
} from "@serenity/core";

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

/** A command that failed in a way that may pass on its own (ADR 0043). */
export function isTransientCommand(error: unknown): boolean {
	return error instanceof CommandError && isTransientMessage(error.stderr);
}

/** Spawning failed because the binary is not on PATH (not, say, a missing cwd). */
function isMissingBinary(error: unknown): boolean {
	return /Executable not found/i.test(String(error));
}

type DependencyListener = (
	dependency: Dependency,
	problem: string | null,
) => void;
const listeners = new Set<DependencyListener>();

/** Hears every call to a dependency: null when it answered, else why it did not. */
export function onDependency(listener: DependencyListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function reportDependency(
	dependency: Dependency,
	problem: string | null,
): void {
	for (const listener of listeners) listener(dependency, problem);
}

const WATCHED: ReadonlySet<string> = new Set<Dependency>(["git", "tmux"]);

/**
 * Runs a command to completion and returns trimmed stdout; throws
 * CommandError on a non-zero exit. `retry` retries transient failures; pass
 * it only for commands that are safe to run twice (ADR 0043).
 */
export async function run(
	command: string[],
	opts: {
		cwd?: string;
		env?: Record<string, string>;
		retry?: boolean | RetryPolicy;
	} = {},
): Promise<string> {
	const once = () => runOnce(command, opts);
	const name = basename(command[0] ?? "");
	const dependency = WATCHED.has(name) ? (name as Dependency) : null;
	try {
		const out = opts.retry
			? await withRetry(once, {
					isTransient: isTransientCommand,
					...(opts.retry === true ? {} : { policy: opts.retry }),
				})
			: await once();
		if (dependency) reportDependency(dependency, null);
		return out;
	} catch (error) {
		if (dependency) {
			// A plain non-zero exit (no such branch, no such pane) means it answered.
			if (isTransientCommand(error))
				reportDependency(dependency, `${dependency} unreachable`);
			else if (error instanceof CommandError)
				reportDependency(dependency, null);
			else if (isMissingBinary(error))
				reportDependency(dependency, `${dependency} not installed`);
		}
		throw error;
	}
}

async function runOnce(
	command: string[],
	opts: { cwd?: string; env?: Record<string, string> },
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

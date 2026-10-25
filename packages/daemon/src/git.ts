import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { run } from "./exec";

export function currentBranch(dir: string): Promise<string> {
	return run(["git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function branchExists(
	repo: string,
	branch: string,
): Promise<boolean> {
	try {
		await run([
			"git",
			"-C",
			repo,
			"rev-parse",
			"--verify",
			"--quiet",
			`refs/heads/${branch}`,
		]);
		return true;
	} catch {
		return false;
	}
}

/** The branch new worktrees start from: origin's HEAD if known, else the repo's current branch. */
export async function defaultBase(repo: string): Promise<string> {
	try {
		return await run([
			"git",
			"-C",
			repo,
			"symbolic-ref",
			"--short",
			"refs/remotes/origin/HEAD",
		]);
	} catch {
		return currentBranch(repo);
	}
}

/** `<parent>/<repo>-<name>`, with a numeric suffix if that path is taken (ADR 0010). */
export function siblingWorktreePath(
	repo: string,
	name: string,
	exists: (path: string) => boolean = existsSync,
): string {
	const base = join(dirname(repo), `${basename(repo)}-${name}`);
	if (!exists(base)) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base}-${n}`;
		if (!exists(candidate)) return candidate;
	}
}

export async function addWorktree(
	repo: string,
	path: string,
	opts: { newBranch: string; base: string } | { branch: string },
) {
	const args =
		"newBranch" in opts
			? ["-b", opts.newBranch, path, opts.base]
			: [path, opts.branch];
	await run(["git", "-C", repo, "worktree", "add", ...args]);
}

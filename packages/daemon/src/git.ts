import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { run } from "./exec";

export function currentBranch(dir: string): Promise<string> {
	return run(["git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
}

/**
 * The repository a directory belongs to, as its shared git dir: the same for
 * the main checkout and every worktree. Null outside git.
 */
export async function commonDir(dir: string): Promise<string | null> {
	try {
		const path = await run([
			"git",
			"-C",
			dir,
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]);
		return realpathSync(path);
	} catch {
		return null;
	}
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

/** Number of changed or untracked files in a worktree. */
export async function dirtyCount(dir: string): Promise<number> {
	const out = await run(["git", "-C", dir, "status", "--porcelain"]);
	return out ? out.split("\n").length : 0;
}

/** Commits on `branch` that `base` does not have. */
export async function commitsNotIn(
	repo: string,
	base: string,
	branch: string,
): Promise<number> {
	return Number(
		await run(["git", "-C", repo, "rev-list", "--count", `${base}..${branch}`]),
	);
}

export async function removeWorktree(
	repo: string,
	path: string,
): Promise<void> {
	await run(["git", "-C", repo, "worktree", "remove", path]);
}

/**
 * `git branch -d` refuses an unmerged branch; `force` (-D) is only used when
 * the branch's merged PR shows nothing is lost (ADR 0011).
 */
export async function deleteBranch(
	repo: string,
	branch: string,
	force = false,
): Promise<void> {
	await run(["git", "-C", repo, "branch", force ? "-D" : "-d", branch]);
}

export async function branchSha(
	repo: string,
	branch: string,
): Promise<string | null> {
	try {
		return await run(["git", "-C", repo, "rev-parse", `refs/heads/${branch}`]);
	} catch {
		return null;
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

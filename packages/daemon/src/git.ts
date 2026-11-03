import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	type BaseSetting,
	type BranchFacts,
	type ResolvedBase,
	remoteOwner,
} from "@serenity/core";
import { run } from "./exec";

export function currentBranch(dir: string): Promise<string> {
	return run(["git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {
		retry: true,
	});
}

/**
 * The repository a directory belongs to, as its shared git dir: the same for
 * the main checkout and every worktree. Null outside git.
 */
export async function commonDir(dir: string): Promise<string | null> {
	try {
		const path = await run(
			[
				"git",
				"-C",
				dir,
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
			],
			{ retry: true },
		);
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
		await run(
			[
				"git",
				"-C",
				repo,
				"rev-parse",
				"--verify",
				"--quiet",
				`refs/heads/${branch}`,
			],
			{ retry: true },
		);
		return true;
	} catch {
		return false;
	}
}

/** The branch new worktrees start from: origin's HEAD if known, else the repo's current branch. */
export async function defaultBase(repo: string): Promise<string> {
	try {
		return await run(
			[
				"git",
				"-C",
				repo,
				"symbolic-ref",
				"--short",
				"refs/remotes/origin/HEAD",
			],
			{ retry: true },
		);
	} catch {
		return currentBranch(repo);
	}
}

/** Whether origin has `branch`, as of the last fetch. */
export async function originBranchExists(
	repo: string,
	branch: string,
): Promise<boolean> {
	try {
		await run(
			[
				"git",
				"-C",
				repo,
				"rev-parse",
				"--verify",
				"--quiet",
				`refs/remotes/origin/${branch}`,
			],
			{ retry: true },
		);
		return true;
	} catch {
		return false;
	}
}

/** The repo's default branch as a base: origin's HEAD, else its current branch. */
export async function repoDefaultBase(
	repo: string,
): Promise<Omit<ResolvedBase, "notice">> {
	const ref = await defaultBase(repo);
	const remote = await run(
		["git", "-C", repo, "symbolic-ref", "-q", "refs/remotes/origin/HEAD"],
		{ retry: true },
	).catch(() => "");
	return {
		ref,
		branch: remote && ref.startsWith("origin/") ? ref.slice(7) : ref,
	};
}

/** A branch named in a setting or the dialog: local first, else origin's. */
async function namedBase(
	repo: string,
	branch: string,
): Promise<Omit<ResolvedBase, "notice"> | null> {
	if (await branchExists(repo, branch)) return { ref: branch, branch };
	if (await originBranchExists(repo, branch))
		return { ref: `origin/${branch}`, branch };
	return null;
}

/**
 * Where a new worktree branches off (ADR 0058). A setting that cannot be
 * followed (a branch that is gone, a detached main checkout) falls back to
 * the repo's default with a notice; an override from the dialog is refused
 * instead, since the user typed it just now.
 */
export async function resolveBase(
	repo: string,
	setting: BaseSetting,
	override?: string,
): Promise<ResolvedBase> {
	const wanted = override?.trim();
	if (wanted) {
		const named = await namedBase(repo, wanted);
		if (!named)
			throw new Error(`no branch ${wanted} here or on origin to start from`);
		return { ...named, notice: null };
	}
	if (setting === "default")
		return { ...(await repoDefaultBase(repo)), notice: null };
	const fallback = async (why: string) => {
		const base = await repoDefaultBase(repo);
		return { ...base, notice: `${why}; using ${base.ref}` };
	};
	if (setting === "current") {
		const branch = await checkedOutBranch(repo);
		return branch
			? { ref: branch, branch, notice: null }
			: fallback("the main checkout is on no branch");
	}
	const named = await namedBase(repo, setting.branch);
	return named
		? { ...named, notice: null }
		: fallback(`no branch ${setting.branch} here or on origin`);
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
	const out = await run(["git", "-C", dir, "status", "--porcelain"], {
		retry: true,
	});
	return out ? out.split("\n").length : 0;
}

/** Commits on `branch` that `base` does not have. */
export async function commitsNotIn(
	repo: string,
	base: string,
	branch: string,
): Promise<number> {
	return Number(
		await run(
			["git", "-C", repo, "rev-list", "--count", `${base}..${branch}`],
			{ retry: true },
		),
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
		return await run(["git", "-C", repo, "rev-parse", `refs/heads/${branch}`], {
			retry: true,
		});
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

/** The branch checked out in `dir`; null when detached or not git. */
export async function checkedOutBranch(dir: string): Promise<string | null> {
	try {
		return (
			(await run(["git", "-C", dir, "symbolic-ref", "--short", "-q", "HEAD"], {
				retry: true,
			})) || null
		);
	} catch {
		return null;
	}
}

/** A local branch and what it tracks (ADR 0055); null if there is no such branch. */
export async function branchFacts(
	dir: string,
	branch: string,
): Promise<BranchFacts | null> {
	const out = await run(
		[
			"git",
			"-C",
			dir,
			"for-each-ref",
			"--format=%(refname:short)%00%(upstream:remotename)%00%(upstream:remoteref)",
			`refs/heads/${branch}`,
		],
		{ retry: true },
	);
	if (!out) return null;
	const [name = branch, remote = "", ref = ""] =
		out.split("\n")[0]?.split("\0") ?? [];
	return {
		name,
		remote: remote || null,
		upstream: ref.replace(/^refs\/heads\//, "") || null,
	};
}

/** Each remote's GitHub owner, from its fetch URL. */
export async function remoteOwners(
	dir: string,
): Promise<Record<string, string>> {
	const out = await run(["git", "-C", dir, "remote", "-v"], { retry: true });
	const owners: Record<string, string> = {};
	for (const line of out.split("\n")) {
		const [name, url, kind] = line.split(/\s+/);
		if (!name || !url || kind !== "(fetch)") continue;
		const owner = remoteOwner(url);
		if (owner) owners[name] = owner;
	}
	return owners;
}

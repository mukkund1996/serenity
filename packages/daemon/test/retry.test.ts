import { afterAll, afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dependency } from "@serenity/core";
import { CommandError, onDependency, run } from "../src/exec";
import { Gh } from "../src/gh";
import { isIdempotent } from "../src/tmux";

const dir = mkdtempSync(join(tmpdir(), "sretry-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
/**
 * A fake binary named `name` that fails `fails` times with `stderr`, then
 * prints `stdout`. Returns its path and how often it ran.
 */
function flaky(name: string, fails: number, stderr: string, stdout = "ok") {
	const home = join(dir, String(n++));
	const count = join(dir, `${n}.count`);
	const bin = join(mkdtempSync(`${home}-`), name);
	writeFileSync(
		bin,
		`#!/bin/sh
n=$(cat '${count}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${count}'
if [ $n -le ${fails} ]; then echo '${stderr}' >&2; exit 1; fi
echo '${stdout}'
`,
	);
	chmodSync(bin, 0o755);
	return { bin, runs: () => Number(readFileSync(count, "utf8")) };
}

const heard: Array<[Dependency, string | null]> = [];
const unhear = onDependency((d, p) => heard.push([d, p]));
afterAll(unhear);
afterEach(() => {
	heard.length = 0;
});

test("run retries a transient failure when asked, and reports git answered", async () => {
	const git = flaky(
		"git",
		2,
		"fatal: Unable to create '/r/.git/index.lock': File exists.",
	);
	expect(await run([git.bin, "status"], { retry: true })).toBe("ok");
	expect(git.runs()).toBe(3);
	expect(heard).toEqual([["git", null]]);
});

test("run does not retry unless asked: writes may not be safe twice", async () => {
	const git = flaky("git", 1, "lost server");
	await expect(run([git.bin, "worktree", "add"])).rejects.toBeInstanceOf(
		CommandError,
	);
	expect(git.runs()).toBe(1);
	expect(heard).toEqual([["git", "git unreachable"]]);
});

test("run does not retry a permanent failure; the dependency still answered", async () => {
	const git = flaky("git", 5, "fatal: not a git repository");
	await expect(run([git.bin, "status"], { retry: true })).rejects.toThrow(
		"not a git repository",
	);
	expect(git.runs()).toBe(1);
	expect(heard).toEqual([["git", null]]);
});

test("run gives up after its tries and reports the dependency unreachable", async () => {
	const tmux = flaky("tmux", 9, "server exited unexpectedly");
	await expect(
		run([tmux.bin, "has-session"], {
			retry: { attempts: 3, baseMs: 1, maxMs: 2 },
		}),
	).rejects.toThrow("server exited unexpectedly");
	expect(tmux.runs()).toBe(3);
	expect(heard).toEqual([["tmux", "tmux unreachable"]]);
});

test("a missing binary reads as not installed", async () => {
	await expect(
		run(["git", "status"], { env: { PATH: join(dir, "empty") } }),
	).rejects.toThrow("Executable not found");
	expect(heard).toEqual([["git", "git not installed"]]);
});

test("only tmux commands safe to repeat are retried", () => {
	expect(
		isIdempotent(["display-message", "-p", "-t", "%1", "#{pane_id}"]),
	).toBe(true);
	expect(isIdempotent(["set-option", "-p", "-t", "%1", "@x", "1"])).toBe(true);
	expect(isIdempotent(["set-option", "-as", "terminal-features", "x"])).toBe(
		false,
	);
	expect(isIdempotent(["send-keys", "-t", "%1", "Enter"])).toBe(false);
	expect(isIdempotent(["new-window", "-d"])).toBe(false);
	expect(isIdempotent(["kill-pane", "-t", "%1"])).toBe(false);
	expect(isIdempotent(["respawn-pane", "-k"])).toBe(false);
});

test("gh reads retry a 502 and report gh answered", async () => {
	const gh = flaky("gh", 1, "HTTP 502: Bad Gateway", "[]");
	const out = await new Gh(gh.bin).reviewRequests(dir);
	expect(out).toEqual({ prs: [], error: null });
	expect(gh.runs()).toBe(2);
	expect(heard).toEqual([["gh", null]]);
});

test("gh does not retry being logged out, and reports it", async () => {
	const gh = flaky("gh", 9, "please run:  gh auth login");
	const out = await new Gh(gh.bin).reviewRequests(dir);
	expect(out.error).toBe("gh not logged in");
	expect(gh.runs()).toBe(1);
	expect(heard).toEqual([["gh", "gh not logged in"]]);
});

test("gh asks for the user again after a failure instead of keeping it", async () => {
	const gh = flaky("gh", 1, "please run:  gh auth login", "octocat");
	const client = new Gh(gh.bin);
	expect(await client.currentUser(dir)).toBeNull();
	expect(await client.currentUser(dir)).toBe("octocat");
	expect(await client.currentUser(dir)).toBe("octocat");
	expect(gh.runs()).toBe(2);
});

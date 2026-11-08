import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatError, notInRepo } from "../src/errors";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

test("headline, detail, then indented lines with aligned notes", () => {
	expect(
		formatError(
			{
				title: "something broke",
				detail: "/some/dir",
				lines: [
					"Try:",
					{ cmd: "serenity doctor", note: "checks things" },
					{ cmd: "serenity restart", note: "restarts" },
				],
			},
			false,
		),
	).toBe(
		[
			"serenity: something broke",
			"  /some/dir",
			"",
			"  Try:",
			"    serenity doctor    checks things",
			"    serenity restart   restarts",
		].join("\n"),
	);
});

test("colour only when asked", () => {
	const msg = { title: "x", lines: [{ cmd: "git init" }] };
	expect(formatError(msg, false)).not.toContain("\x1b[");
	expect(formatError(msg, true)).toContain("\x1b[1;31mserenity:\x1b[0m");
});

test("git missing says so instead of blaming the folder", () => {
	const text = formatError(
		notInRepo("/x", "serenity", { gitMissing: true }),
		false,
	);
	expect(text).toContain("git is not installed");
	expect(text).not.toContain("/x");
});

test("serenity outside a repo names the folder and how to get into one", () => {
	const dir = mkdtempSync(join(tmpdir(), "serenity-norepo-"));
	try {
		const result = spawnSync(process.execPath, [MAIN], {
			cwd: dir,
			env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir(), NO_COLOR: "1" },
			encoding: "utf8",
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("serenity: not inside a git repository");
		expect(result.stderr).toContain("cd path/to/your/repo");
		expect(result.stderr).toContain("git init");
		expect(result.stdout).toBe("");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

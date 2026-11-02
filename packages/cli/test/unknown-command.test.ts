import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

function runCli(
	args: string[],
	env: Record<string, string> = {},
): {
	stdout: string;
	stderr: string;
	status: number | null;
} {
	return spawnSync(process.execPath, [MAIN, ...args], {
		env: { ...process.env, ...env },
		encoding: "utf8",
	});
}

test("unknown command prints error and usage to stderr, exits with code 2", () => {
	const result = runCli(["foobar"]);
	expect(result.status).toBe(2);
	expect(result.stderr).toContain(`serenity: unknown command "foobar"`);
	expect(result.stderr).toContain("usage:");
	expect(result.stderr).toContain("serenity doctor");
	expect(result.stdout).toBe("");
});

test("help command prints usage to stdout and exits with code 0", () => {
	const result = runCli(["help"]);
	expect(result.status).toBe(0);
	expect(result.stdout).toContain("usage:");
	expect(result.stdout).toContain("serenity doctor");
	expect(result.stderr).toBe("");
});

test("--help flag prints usage to stdout and exits with code 0", () => {
	const result = runCli(["--help"]);
	expect(result.status).toBe(0);
	expect(result.stdout).toContain("usage:");
	expect(result.stdout).toContain("serenity doctor");
	expect(result.stderr).toBe("");
});

test("-h flag prints usage to stdout and exits with code 0", () => {
	const result = runCli(["-h"]);
	expect(result.status).toBe(0);
	expect(result.stdout).toContain("usage:");
	expect(result.stdout).toContain("serenity doctor");
	expect(result.stderr).toBe("");
});

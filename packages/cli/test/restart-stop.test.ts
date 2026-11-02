import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

test("restart with no daemon does not print 'daemon is not running' (#84)", () => {
	const home = mkdtempSync(join(tmpdir(), "serenity-restart-"));
	try {
		const result = runCli(["restart"], { SERENITY_HOME: home });
		expect(result.status).toBe(0);
		expect(result.stdout).not.toContain("daemon is not running");
		expect(result.stdout).toMatch(/daemon running /);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("stop with no daemon still prints 'daemon is not running'", () => {
	const home = mkdtempSync(join(tmpdir(), "serenity-stop-"));
	try {
		const result = runCli(["stop"], { SERENITY_HOME: home });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("daemon is not running");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

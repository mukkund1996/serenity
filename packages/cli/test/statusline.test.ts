import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUserStatusLine, userStatusLineCommand } from "../src/statusline";

let dir = "";
let project = "";
let config = "";

const write = (path: string, command: string) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify({ statusLine: { type: "command", command } }),
	);
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "serenity-statusline-"));
	project = join(dir, "project");
	config = join(dir, "claude");
	mkdirSync(project, { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("the user's status line: local, then project, then user settings", () => {
	const env = { CLAUDE_CONFIG_DIR: config };
	const input = { workspace: { project_dir: project } };
	expect(userStatusLineCommand(input, env)).toBeNull();
	write(join(config, "settings.json"), "user");
	expect(userStatusLineCommand(input, env)).toBe("user");
	write(join(project, ".claude", "settings.json"), "project");
	expect(userStatusLineCommand(input, env)).toBe("project");
	write(join(project, ".claude", "settings.local.json"), "local");
	expect(userStatusLineCommand(input, env)).toBe("local");
});

test("the user's status line gets Claude's JSON and its output is passed on", async () => {
	expect(await runUserStatusLine("tr a-z A-Z", '{"a":1}', project)).toBe(
		'{"A":1}',
	);
	expect(await runUserStatusLine("exit 3", "", project)).toBe("");
});

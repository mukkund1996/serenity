/** The login popup's command (ADR 0065). */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { popupCommand } from "../src/popup";

test("runs serenity with the map's serenity, gh and Claude settings, quoted for the shell", () => {
	const command = popupCommand(["setup", "github", "--popup"], {
		// Prints its environment, then its name and arguments.
		SERENITY_SELF: JSON.stringify([
			"/bin/sh",
			"-c",
			'env; echo "$0 $*"',
			"it's me",
		]),
		SERENITY_HOME: "/tmp/a home",
		XDG_CONFIG_HOME: "/tmp/config",
		CLAUDE_CONFIG_DIR: "/tmp/claude",
		PATH: "/usr/bin:/bin",
		SECRET_TOKEN: "never-passed",
		TMUX: "/tmp/tmux-501/default,1,0",
	});
	expect(command).not.toContain("SECRET_TOKEN");
	expect(command).not.toContain("TMUX=");
	const out = spawnSync("/bin/sh", ["-c", command], {
		encoding: "utf8",
		env: {},
	}).stdout;
	expect(out).toContain("SERENITY_HOME=/tmp/a home\n");
	expect(out).toContain("CLAUDE_CONFIG_DIR=/tmp/claude\n");
	expect(out).not.toContain("never-passed");
	expect(out.trim().split("\n").at(-1)).toBe("it's me setup github --popup");
});

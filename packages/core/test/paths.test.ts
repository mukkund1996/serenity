import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	agentMcpPath,
	claudeConfigDir,
	crashReportsDir,
	daemonCrashPath,
	daemonLockPath,
	daemonLogPath,
	dbPath,
	doctorMarkerPath,
	handoversDir,
	handoversRoot,
	hookSettingsPath,
	masterPluginPath,
	serenityHome,
	socketPath,
	tmuxSessionName,
	tutorialPluginPath,
} from "../src/paths";

const home = "/tmp/serenity-test";

describe("serenityHome", () => {
	test("prefers SERENITY_HOME over XDG_STATE_HOME", () => {
		expect(
			serenityHome({
				SERENITY_HOME: "/custom/serenity",
				XDG_STATE_HOME: "/xdg/state",
			}),
		).toBe("/custom/serenity");
	});

	test("uses XDG_STATE_HOME when SERENITY_HOME is unset", () => {
		expect(serenityHome({ XDG_STATE_HOME: "/xdg/state" })).toBe(
			join("/xdg/state", "serenity"),
		);
	});

	test("falls back to the default state directory", () => {
		expect(serenityHome({})).toBe(
			join(homedir(), ".local", "state", "serenity"),
		);
	});
});

describe("home path helpers", () => {
	test("resolves socket and database paths", () => {
		expect(socketPath(home)).toBe(join(home, "serenity.sock"));
		expect(dbPath(home)).toBe(join(home, "serenity.db"));
	});

	test("resolves daemon paths", () => {
		expect(daemonLogPath(home)).toBe(join(home, "daemon.log"));
		expect(daemonLockPath(home)).toBe(join(home, "daemon.lock"));
		expect(daemonCrashPath(home)).toBe(join(home, "crash.json"));
	});

	test("resolves crash report directory", () => {
		expect(crashReportsDir(home)).toBe(join(home, "crash-reports"));
	});

	test("resolves plugin and hook paths", () => {
		expect(masterPluginPath(home)).toBe(join(home, "master-plugin"));
		expect(tutorialPluginPath(home)).toBe(join(home, "tutorial-plugin"));
		expect(hookSettingsPath(home)).toBe(join(home, "claude-hooks.json"));
		expect(agentMcpPath(home)).toBe(join(home, "agent-mcp.json"));
	});

	test("resolves Claude config directory", () => {
		expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/custom/claude" })).toBe(
			"/custom/claude",
		);
		expect(claudeConfigDir({})).toBe(join(homedir(), ".claude"));
	});

	test("resolves handover and doctor paths", () => {
		expect(handoversRoot(home)).toBe(join(home, "handovers"));
		expect(doctorMarkerPath(home)).toBe(join(home, ".doctor-ok"));
	});
});

describe("tmuxSessionName", () => {
	test("uses the repository folder name", () => {
		expect(tmuxSessionName("/code/serenity")).toBe("serenity-serenity");
	});

	test("lowercases names and replaces spaces with dashes", () => {
		expect(tmuxSessionName("/code/My Repo")).toBe("serenity-my-repo");
	});

	test("normalizes dots and symbols", () => {
		expect(tmuxSessionName("/code/.dotfiles")).toBe("serenity-dotfiles");
		expect(tmuxSessionName("/code/foo..bar!")).toBe("serenity-foo-bar");
		expect(tmuxSessionName("/code/..foo!!!bar..")).toBe("serenity-foo-bar");
	});

	test("preserves underscores and existing dashes", () => {
		expect(tmuxSessionName("/code/my_repo-name")).toBe("serenity-my_repo-name");
	});

	test("falls back to repo when the folder name has no valid characters", () => {
		expect(tmuxSessionName("/code/!!!...")).toBe("serenity-repo");
	});
});

describe("handoversDir", () => {
	test("uses the normalized repository slug", () => {
		expect(handoversDir(home, "/code/My Repo")).toBe(
			join(home, "handovers", "my-repo"),
		);
	});

	test("uses the same slug normalization as tmuxSessionName", () => {
		const repo = "/code/foo..bar!";
		const slug = tmuxSessionName(repo).replace(/^serenity-/, "");

		expect(handoversDir(home, repo)).toBe(join(home, "handovers", slug));
	});
});

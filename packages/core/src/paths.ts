import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * Everything serenity keeps on disk lives under one home directory so tests
 * can point SERENITY_HOME at a temp dir.
 */
export function serenityHome(env: NodeJS.ProcessEnv = process.env): string {
	if (env.SERENITY_HOME) return env.SERENITY_HOME;
	const state = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
	return join(state, "serenity");
}

export const socketPath = (home: string) => join(home, "serenity.sock");
export const dbPath = (home: string) => join(home, "serenity.db");
export const daemonLogPath = (home: string) => join(home, "daemon.log");
/** The plugin holding the master chat's skill, rewritten on every daemon start. */
export const masterPluginPath = (home: string) => join(home, "master-plugin");
export const hookSettingsPath = (home: string) =>
	join(home, "claude-hooks.json");
/** Claude Code's own config dir; CLAUDE_CONFIG_DIR moves it, as in Claude Code. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export const doctorMarkerPath = (home: string) => join(home, ".doctor-ok");

/** tmux session that hosts the map and parks the agents of one repo. */
export function tmuxSessionName(repo: string): string {
	const slug = basename(repo)
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `serenity-${slug || "repo"}`;
}

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_SLACK_MCP } from "./slack";

/** `~/.config/serenity/config.json` (ADR 0012). Every field is optional. */
export interface Config {
	/** Model aliases or ids for the master's roles (ADR 0007). */
	models: { chat: string; summarizer: string; suggester: string };
	/** GitHub logins to suggest as reviewers when CODEOWNERS names nobody (ADR 0011). */
	reviewers: string[];
	/** Most topics the summarizer may create per repo; past it, sessions join an existing one. */
	maxTopics: number;
	/** Slack for the master (ADR 0023). */
	slack: {
		/** Repos (absolute, `~` allowed) whose map shows Slack; none by default. */
		repos: string[];
		/** The MCP server entry for Slack, as `--mcp-config` takes it. */
		mcp: Record<string, unknown>;
	};
	/** Crash reports filed as GitHub issues (ADR 0044); off until the user turns them on. */
	crashReports: {
		enabled: boolean;
		/** `owner/name` the issues go to. */
		repo: string;
	};
}

export const DEFAULT_CONFIG: Config = {
	models: { chat: "opus", summarizer: "haiku", suggester: "sonnet" },
	reviewers: [],
	maxTopics: 10,
	slack: { repos: [], mcp: DEFAULT_SLACK_MCP },
	crashReports: { enabled: false, repo: "mukkund1996/serenity" },
};

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** Repos are named by their real path, as `git rev-parse --show-toplevel` gives it. */
function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	const base = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	return join(base, "serenity", "config.json");
}

/** Reads the config, falling back to defaults for anything missing or malformed. */
export function loadConfig(path = configPath()): Config {
	if (!existsSync(path)) return DEFAULT_CONFIG;
	let raw: {
		models?: Partial<Config["models"]>;
		reviewers?: unknown;
		maxTopics?: unknown;
		slack?: { repos?: unknown; mcp?: unknown };
		crashReports?: { enabled?: unknown; repo?: unknown };
	};
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return DEFAULT_CONFIG;
	}
	const pick = (value: unknown, fallback: string) =>
		typeof value === "string" && value.trim() ? value.trim() : fallback;
	const models = raw.models ?? {};
	return {
		models: {
			chat: pick(models.chat, DEFAULT_CONFIG.models.chat),
			summarizer: pick(models.summarizer, DEFAULT_CONFIG.models.summarizer),
			suggester: pick(models.suggester, DEFAULT_CONFIG.models.suggester),
		},
		reviewers: Array.isArray(raw.reviewers)
			? raw.reviewers
					.filter((r): r is string => typeof r === "string" && !!r.trim())
					.map((r) => r.trim().replace(/^@/, ""))
			: [],
		maxTopics:
			Number.isInteger(raw.maxTopics) && (raw.maxTopics as number) > 0
				? (raw.maxTopics as number)
				: DEFAULT_CONFIG.maxTopics,
		slack: {
			repos: Array.isArray(raw.slack?.repos)
				? raw.slack.repos
						.filter((r): r is string => typeof r === "string" && !!r.trim())
						.map((r) => realPath(r.trim().replace(/^~(?=$|\/)/, homedir())))
				: [],
			mcp:
				raw.slack?.mcp && typeof raw.slack.mcp === "object"
					? (raw.slack.mcp as Record<string, unknown>)
					: DEFAULT_CONFIG.slack.mcp,
		},
		crashReports: {
			enabled: raw.crashReports?.enabled === true,
			repo:
				typeof raw.crashReports?.repo === "string" &&
				REPO_PATTERN.test(raw.crashReports.repo.trim())
					? raw.crashReports.repo.trim()
					: DEFAULT_CONFIG.crashReports.repo,
		},
	};
}

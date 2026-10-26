import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `~/.config/serenity/config.json` (ADR 0012). Every field is optional. */
export interface Config {
	/** Model aliases or ids for the master's roles (ADR 0007). */
	models: { chat: string; summarizer: string; suggester: string };
	/** GitHub logins to suggest as reviewers when CODEOWNERS names nobody (ADR 0011). */
	reviewers: string[];
	/** Most topics the summarizer may create per repo; past it, sessions join an existing one. */
	maxTopics: number;
}

export const DEFAULT_CONFIG: Config = {
	models: { chat: "opus", summarizer: "haiku", suggester: "sonnet" },
	reviewers: [],
	maxTopics: 10,
};

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
	};
}

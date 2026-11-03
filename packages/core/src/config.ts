import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PRIVATE_FILE } from "./private";
import { DEFAULT_SLACK_MCP } from "./slack";

/**
 * The branch new session worktrees start from (ADR 0058): the repo's default
 * branch (origin's HEAD), the branch the main checkout is on, or a named one.
 */
export type BaseSetting = "default" | "current" | { branch: string };

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
	/** Crash reports filed as GitHub issues (ADR 0045); off until the user turns them on. */
	crashReports: {
		enabled: boolean;
		/** `owner/name` the issues go to. */
		repo: string;
	};
	/** Where new session worktrees branch off, for repos with no setting of their own. */
	baseBranch: BaseSetting;
	/** Settings for one repo, keyed by its real path (`~` allowed in the file). */
	repos: Record<string, { baseBranch?: BaseSetting }>;
}

export const DEFAULT_CONFIG: Config = {
	models: { chat: "opus", summarizer: "haiku", suggester: "sonnet" },
	reviewers: [],
	maxTopics: 10,
	slack: { repos: [], mcp: DEFAULT_SLACK_MCP },
	crashReports: { enabled: false, repo: "mukkund1996/serenity" },
	baseBranch: "default",
	repos: {},
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

/** A repo path as the file may write it (`~`, a link), as the daemon names it. */
export function repoKey(path: string): string {
	return realPath(path.trim().replace(/^~(?=$|\/)/, homedir()));
}

/** A base setting from the file; null when it is not one. */
export function parseBaseSetting(value: unknown): BaseSetting | null {
	if (value === "default" || value === "current") return value;
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const branch = (value as { branch?: unknown }).branch;
		if (typeof branch === "string" && branch.trim())
			return { branch: branch.trim() };
	}
	return null;
}

/** The setting that applies to `repo`: its own, else the global one. */
export function baseSettingFor(config: Config, repo: string): BaseSetting {
	return config.repos[repoKey(repo)]?.baseBranch ?? config.baseBranch;
}

/** How a base setting reads in the settings panel and the new-session dialog. */
export function describeBaseSetting(setting: BaseSetting): string {
	if (setting === "default") return "repo default";
	if (setting === "current") return "current branch";
	return setting.branch;
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
		baseBranch?: unknown;
		repos?: unknown;
	};
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return DEFAULT_CONFIG;
	}
	const pick = (value: unknown, fallback: string) =>
		typeof value === "string" && value.trim() ? value.trim() : fallback;
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		return DEFAULT_CONFIG;
	const models = raw.models ?? {};
	const repos: Config["repos"] = {};
	if (raw.repos && typeof raw.repos === "object" && !Array.isArray(raw.repos))
		for (const [path, entry] of Object.entries(raw.repos)) {
			if (!path.trim() || !entry || typeof entry !== "object") continue;
			const baseBranch = parseBaseSetting(
				(entry as { baseBranch?: unknown }).baseBranch,
			);
			repos[repoKey(path)] = baseBranch ? { baseBranch } : {};
		}
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
		baseBranch: parseBaseSetting(raw.baseBranch) ?? DEFAULT_CONFIG.baseBranch,
		repos,
	};
}

// ------------------------------------------------- writing the file

/** One change the settings panel makes (ADR 0058). */
export type ConfigChange =
	| { key: "baseBranch"; scope: "global"; value: BaseSetting }
	/** null: the repo follows the global setting again. */
	| {
			key: "baseBranch";
			scope: "repo";
			repo: string;
			value: BaseSetting | null;
	  }
	| { key: "model"; role: keyof Config["models"]; value: string }
	| { key: "maxTopics"; value: number }
	| { key: "slack"; repo: string; value: boolean };

/** Model aliases the settings panel steps through; a custom id in the file is kept as one more. */
export const MODEL_CHOICES = ["opus", "sonnet", "haiku"];
/** The settings panel's range for maxTopics. */
export const MAX_TOPICS_RANGE = [1, 30] as const;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
	!!value && typeof value === "object" && !Array.isArray(value);

/** `parent[key]` as an object, made one if it is missing or something else. */
function objectAt(parent: Json, key: string): Json {
	const value = parent[key];
	if (isObject(value)) return value;
	const fresh: Json = {};
	parent[key] = fresh;
	return fresh;
}

/** The key the file already uses for `repo` (written `~/x` or via a link), else its path. */
function fileKeyFor(entries: Json, repo: string): string {
	const want = repoKey(repo);
	return Object.keys(entries).find((k) => repoKey(k) === want) ?? want;
}

/**
 * Applies a change to the file's parsed JSON in place. Only the keys the
 * change names are touched; everything else, unknown keys too, is kept.
 */
export function applyConfigChange(raw: Json, change: ConfigChange): void {
	switch (change.key) {
		case "baseBranch": {
			if (change.scope === "global") {
				raw.baseBranch = change.value;
				return;
			}
			const repos = objectAt(raw, "repos");
			const key = fileKeyFor(repos, change.repo);
			if (change.value === null) {
				const entry = repos[key];
				if (!isObject(entry)) return;
				delete entry.baseBranch;
				if (!Object.keys(entry).length) delete repos[key];
				if (!Object.keys(repos).length) delete raw.repos;
				return;
			}
			objectAt(repos, key).baseBranch = change.value;
			return;
		}
		case "model":
			objectAt(raw, "models")[change.role] = change.value;
			return;
		case "maxTopics":
			raw.maxTopics = change.value;
			return;
		case "slack": {
			const slack = objectAt(raw, "slack");
			const listed = Array.isArray(slack.repos) ? slack.repos : [];
			const want = repoKey(change.repo);
			const others = listed.filter(
				(r) => typeof r !== "string" || repoKey(r) !== want,
			);
			slack.repos = change.value ? [...others, want] : others;
			return;
		}
	}
}

/** The indent the file uses: its first indented line's, else a tab. */
function indentOf(text: string): string {
	return text.match(/^([ \t]+)\S/m)?.[1] ?? "\t";
}

/**
 * Writes changes to config.json (ADR 0058): read, change only the keys
 * named, write a temporary file beside it and rename it over, so a reader
 * never sees half a file. The indent and key order are kept. A file that
 * is not valid JSON is refused rather than replaced, so a hand edit with a
 * typo is never lost. A new file is the user's alone, as it may hold
 * Slack's MCP settings; an existing one keeps its mode.
 */
export function writeConfig(
	changes: ConfigChange[],
	path = configPath(),
): void {
	const exists = existsSync(path);
	const text = exists ? readFileSync(path, "utf8") : "";
	let raw: unknown = {};
	if (text.trim())
		try {
			raw = JSON.parse(text);
		} catch (e) {
			throw new Error(
				`${path} is not valid JSON (${(e as Error).message}); fix it, then change settings again`,
			);
		}
	if (!isObject(raw))
		throw new Error(`${path} does not hold a JSON object; fix it first`);
	for (const change of changes) applyConfigChange(raw, change);
	const out = `${JSON.stringify(raw, null, indentOf(text))}${
		text && !text.endsWith("\n") ? "" : "\n"
	}`;
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, out, {
		mode: exists ? statSync(path).mode & 0o777 : PRIVATE_FILE,
	});
	if (exists) chmodSync(tmp, statSync(path).mode & 0o777);
	renameSync(tmp, path);
}

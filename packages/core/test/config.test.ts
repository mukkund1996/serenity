import { afterAll, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	baseSettingFor,
	DEFAULT_CONFIG,
	loadConfig,
	writeConfig,
} from "../src/config";

const dir = mkdtempSync(join(tmpdir(), "scfg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("defaults when the file is missing or broken", () => {
	expect(loadConfig(join(dir, "missing.json"))).toEqual(DEFAULT_CONFIG);
	writeFileSync(join(dir, "bad.json"), "{nope");
	expect(loadConfig(join(dir, "bad.json"))).toEqual(DEFAULT_CONFIG);
});

test("overrides only the models that are set", () => {
	writeFileSync(
		join(dir, "c.json"),
		JSON.stringify({ models: { chat: "sonnet", suggester: " " } }),
	);
	expect(loadConfig(join(dir, "c.json")).models).toEqual({
		chat: "sonnet",
		summarizer: "haiku",
		suggester: "sonnet",
	});
});

test("reviewers are logins without the @", () => {
	writeFileSync(
		join(dir, "r.json"),
		JSON.stringify({ reviewers: ["@alice", "bob", 3, " "] }),
	);
	expect(loadConfig(join(dir, "r.json")).reviewers).toEqual(["alice", "bob"]);
});

test("maxTopics is a positive whole number", () => {
	writeFileSync(join(dir, "t.json"), JSON.stringify({ maxTopics: 6 }));
	expect(loadConfig(join(dir, "t.json")).maxTopics).toBe(6);
	writeFileSync(join(dir, "t0.json"), JSON.stringify({ maxTopics: 0 }));
	expect(loadConfig(join(dir, "t0.json")).maxTopics).toBe(10);
});

test("the first-boot tutorial is on unless onboarding is false (ADR 0062)", () => {
	expect(loadConfig(join(dir, "missing.json")).onboarding).toBe(true);
	writeFileSync(join(dir, "o.json"), JSON.stringify({ onboarding: false }));
	expect(loadConfig(join(dir, "o.json")).onboarding).toBe(false);
	writeFileSync(join(dir, "o2.json"), JSON.stringify({ onboarding: "no" }));
	expect(loadConfig(join(dir, "o2.json")).onboarding).toBe(true);
});

test("Slack is off unless repos list it; ~ and links resolve to real paths", () => {
	expect(loadConfig(join(dir, "missing.json")).slack.repos).toEqual([]);
	writeFileSync(
		join(dir, "s.json"),
		JSON.stringify({ slack: { repos: ["~/code/app", dir, 4] } }),
	);
	const slack = loadConfig(join(dir, "s.json")).slack;
	expect(slack.repos).toEqual([join(homedir(), "code/app"), realpathSync(dir)]);
	expect(slack.mcp).toEqual(DEFAULT_CONFIG.slack.mcp);
	writeFileSync(
		join(dir, "m.json"),
		JSON.stringify({ slack: { mcp: { type: "stdio", command: "slack-mcp" } } }),
	);
	expect(loadConfig(join(dir, "m.json")).slack.mcp).toEqual({
		type: "stdio",
		command: "slack-mcp",
	});
});

test("crash reports are off by default and need an owner/name repo", () => {
	expect(loadConfig(join(dir, "missing.json")).crashReports).toEqual({
		enabled: false,
		repo: "mukkund1996/serenity",
	});
	writeFileSync(
		join(dir, "cr.json"),
		JSON.stringify({ crashReports: { enabled: true, repo: " me/fork " } }),
	);
	expect(loadConfig(join(dir, "cr.json")).crashReports).toEqual({
		enabled: true,
		repo: "me/fork",
	});
	writeFileSync(
		join(dir, "cr2.json"),
		JSON.stringify({ crashReports: { enabled: "yes", repo: "no slash" } }),
	);
	expect(loadConfig(join(dir, "cr2.json")).crashReports).toEqual(
		DEFAULT_CONFIG.crashReports,
	);
});

test("the base branch is the repo default unless set; a repo's own setting wins", () => {
	expect(loadConfig(join(dir, "missing.json")).baseBranch).toBe("default");
	writeFileSync(
		join(dir, "b.json"),
		JSON.stringify({
			baseBranch: "current",
			repos: {
				[dir]: { baseBranch: { branch: " develop " } },
				"~/code/app": { baseBranch: "nonsense" },
			},
		}),
	);
	const config = loadConfig(join(dir, "b.json"));
	expect(config.baseBranch).toBe("current");
	expect(baseSettingFor(config, dir)).toEqual({ branch: "develop" });
	// An invalid setting is ignored, so the repo follows the global one.
	expect(baseSettingFor(config, join(homedir(), "code/app"))).toBe("current");
	expect(baseSettingFor(config, "/elsewhere")).toBe("current");
	writeFileSync(join(dir, "b2.json"), JSON.stringify({ baseBranch: 7 }));
	expect(loadConfig(join(dir, "b2.json")).baseBranch).toBe("default");
});

test("writeConfig changes only the keys named, keeping unknown keys, order and indent", () => {
	const path = join(dir, "w.json");
	writeFileSync(
		path,
		'{\n    "future": {"x": 1},\n    "models": {\n        "chat": "sonnet"\n    },\n    "maxTopics": 4\n}\n',
	);
	writeConfig(
		[
			{ key: "model", role: "suggester", value: "haiku" },
			{ key: "maxTopics", value: 12 },
			{ key: "baseBranch", scope: "global", value: { branch: "develop" } },
		],
		path,
	);
	const text = readFileSync(path, "utf8");
	expect(text).toBe(
		`${JSON.stringify(
			{
				future: { x: 1 },
				models: { chat: "sonnet", suggester: "haiku" },
				maxTopics: 12,
				baseBranch: { branch: "develop" },
			},
			null,
			4,
		)}\n`,
	);
	expect(loadConfig(path).models).toEqual({
		chat: "sonnet",
		summarizer: "haiku",
		suggester: "haiku",
	});
	// Nothing is left beside it.
	expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("writeConfig sets and clears a repo's base under the key the file already uses", () => {
	const path = join(dir, "r2.json");
	const repo = realpathSync(dir);
	writeFileSync(
		path,
		JSON.stringify({
			repos: { [`${dir}/`]: { baseBranch: "current", note: 1 } },
		}),
	);
	writeConfig(
		[{ key: "baseBranch", scope: "repo", repo, value: { branch: "main" } }],
		path,
	);
	expect(JSON.parse(readFileSync(path, "utf8")).repos).toEqual({
		[`${dir}/`]: { baseBranch: { branch: "main" }, note: 1 },
	});
	writeConfig([{ key: "baseBranch", scope: "repo", repo, value: null }], path);
	expect(JSON.parse(readFileSync(path, "utf8")).repos).toEqual({
		[`${dir}/`]: { note: 1 },
	});
	// A repo with nothing left is dropped, and so is an empty repos.
	const bare = join(dir, "r3.json");
	writeConfig(
		[{ key: "baseBranch", scope: "repo", repo, value: "current" }],
		bare,
	);
	expect(baseSettingFor(loadConfig(bare), repo)).toBe("current");
	writeConfig([{ key: "baseBranch", scope: "repo", repo, value: null }], bare);
	expect(JSON.parse(readFileSync(bare, "utf8"))).toEqual({});
});

test("writeConfig turns Slack on and off for one repo, keeping the others", () => {
	const path = join(dir, "sl.json");
	const repo = realpathSync(dir);
	writeFileSync(
		path,
		JSON.stringify({ slack: { repos: ["~/other", dir], mcp: { a: 1 } } }),
	);
	writeConfig([{ key: "slack", repo, value: false }], path);
	expect(JSON.parse(readFileSync(path, "utf8")).slack).toEqual({
		repos: ["~/other"],
		mcp: { a: 1 },
	});
	writeConfig([{ key: "slack", repo, value: true }], path);
	expect(loadConfig(path).slack.repos).toContain(repo);
});

test("writeConfig makes a new file the user's alone and keeps an existing file's mode", () => {
	const fresh = join(mkdtempSync(join(dir, "new-")), "serenity", "config.json");
	writeConfig([{ key: "maxTopics", value: 3 }], fresh);
	expect(statSync(fresh).mode & 0o777).toBe(0o600);
	expect(readFileSync(fresh, "utf8")).toBe('{\n\t"maxTopics": 3\n}\n');
	const shared = join(dir, "mode.json");
	writeFileSync(shared, "{}");
	chmodSync(shared, 0o644);
	writeConfig([{ key: "maxTopics", value: 3 }], shared);
	expect(statSync(shared).mode & 0o777).toBe(0o644);
});

test("writeConfig refuses a file that is not valid JSON and leaves it as it was", () => {
	const path = join(dir, "broken.json");
	writeFileSync(path, '{"maxTopics": 3,');
	expect(() => writeConfig([{ key: "maxTopics", value: 5 }], path)).toThrow(
		/not valid JSON/,
	);
	expect(readFileSync(path, "utf8")).toBe('{"maxTopics": 3,');
	expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
});

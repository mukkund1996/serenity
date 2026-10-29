import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../src/config";

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

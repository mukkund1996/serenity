import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

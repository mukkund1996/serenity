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

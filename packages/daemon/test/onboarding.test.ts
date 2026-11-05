/** The first-boot tutorial (ADR 0062): once per home, skippable, with its plugin. */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CreateSessionParams, createMemoryStorage } from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import {
	Onboarding,
	TUTORIAL_NAME,
	TUTORIAL_PROMPT,
	writeTutorialPlugin,
} from "../src/onboarding";

const REPO = "/repos/demo";

function setup(opts: { enabled?: boolean; fail?: string } = {}) {
	const storage = createMemoryStorage();
	const created: CreateSessionParams[] = [];
	const logs: string[] = [];
	let n = 0;
	const onboarding = new Onboarding({
		storage,
		enabled: () => opts.enabled ?? true,
		currentBranch: async () => "main",
		create: async (params, onId) => {
			if (opts.fail) throw new Error(opts.fail);
			const id = `s${++n}`;
			onId(id);
			// Launching reads the record now, before the session is stored.
			expect(onboarding.isTutorial(id)).toBe(true);
			created.push(params);
			const session = makeSession({ id, name: params.name, repo: REPO });
			storage.sessions.put(session);
			return session;
		},
		now: () => 7,
		log: (line) => logs.push(line),
	});
	return { storage, onboarding, created, logs };
}

describe("first boot", () => {
	test("starts learn-serenity in the repo itself, prompted to teach serenity", async () => {
		const t = setup();
		await t.onboarding.mapOpened(REPO);
		expect(t.created).toEqual([
			{
				repo: REPO,
				name: TUTORIAL_NAME,
				cwd: REPO,
				mode: "branch",
				branch: "main",
				prompt: "teach me how to use serenity",
			},
		]);
		expect(TUTORIAL_PROMPT).toBe("teach me how to use serenity");
		expect(t.onboarding.record).toEqual({
			at: 7,
			repo: REPO,
			sessionId: "s1",
		});
		expect(t.onboarding.isTutorial("s1")).toBe(true);
		expect(t.onboarding.isTutorial("other")).toBe(false);
	});

	test("runs once: not again on another map, nor after it is archived", async () => {
		const t = setup();
		await t.onboarding.mapOpened(REPO);
		const tutorial = t.storage.sessions.get("s1");
		if (!tutorial) throw new Error("no tutorial");
		t.storage.sessions.put({ ...tutorial, status: "archived" });
		await t.onboarding.mapOpened(REPO);
		await t.onboarding.mapOpened("/repos/other");
		expect(t.created).toHaveLength(1);
	});

	test("two maps opening at once start one tutorial", async () => {
		const t = setup();
		await Promise.all([
			t.onboarding.mapOpened(REPO),
			t.onboarding.mapOpened("/repos/other"),
		]);
		expect(t.created).toHaveLength(1);
	});

	test("a home that already has sessions is marked done without one", async () => {
		const t = setup();
		t.storage.sessions.put(
			makeSession({ id: "old", repo: "/repos/elsewhere" }),
		);
		await t.onboarding.mapOpened(REPO);
		expect(t.created).toEqual([]);
		expect(t.onboarding.record).toMatchObject({
			sessionId: null,
			skipped: "existing sessions",
		});
	});

	test("turned off, it is skipped for good", async () => {
		const t = setup({ enabled: false });
		await t.onboarding.mapOpened(REPO);
		expect(t.created).toEqual([]);
		expect(t.onboarding.record).toMatchObject({ skipped: "off" });
	});

	test("a failed start is logged and not retried", async () => {
		const t = setup({ fail: "claude not found" });
		await t.onboarding.mapOpened(REPO);
		await t.onboarding.mapOpened(REPO);
		expect(t.onboarding.record).toMatchObject({
			repo: REPO,
			sessionId: null,
			skipped: "claude not found",
		});
		expect(t.logs.at(-1)).toContain("did not start: claude not found");
	});
});

describe("the tutorial plugin", () => {
	const dir = mkdtempSync(join(tmpdir(), "sr-tutorial-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("is the learn-serenity skill from plugins/, written for --plugin-dir", () => {
		writeTutorialPlugin(dir);
		const manifest = JSON.parse(
			readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"),
		);
		expect(manifest.name).toBe("learn-serenity");
		const skill = readFileSync(
			join(dir, "skills", "learn-serenity", "SKILL.md"),
			"utf8",
		);
		const source = readFileSync(
			new URL(
				"../../../plugins/learn-serenity/skills/learn-serenity/SKILL.md",
				import.meta.url,
			),
			"utf8",
		);
		expect(skill).toBe(source);
		expect(skill).toMatch(/^---\nname: learn-serenity\n/);
		expect(skill).toContain("teach me how to use serenity");
		expect(skill).toContain("https://getserenity.dev/docs/");
		for (const topic of ["NEEDS YOU", "Ctrl+q", "Ctrl+w", "`N`", "PR"])
			expect(skill).toContain(topic);
		expect(existsSync(join(dir, "skills", "learn-serenity"))).toBe(true);
	});

	test("is listed in the serenity marketplace", () => {
		const marketplace = JSON.parse(
			readFileSync(
				new URL("../../../.claude-plugin/marketplace.json", import.meta.url),
				"utf8",
			),
		);
		expect(marketplace.plugins).toContainEqual(
			expect.objectContaining({
				name: "learn-serenity",
				source: "./plugins/learn-serenity",
			}),
		);
	});
});

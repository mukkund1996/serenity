/** The setup steps' checks (ADR 0065), against the E2E fakes of gh and claude. */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubStatus, slackLogin, slackStatus } from "../src/setup";

const ROOT = join(import.meta.dir, "..", "..", "..");
const FAKE_GH = join(ROOT, "e2e/fake-gh.ts");
const FAKE_CLAUDE = [process.execPath, join(ROOT, "e2e/fake-claude.ts")];

const dir = mkdtempSync(join(tmpdir(), "srsetup-"));
const workers = join(dir, "workers");
const saved = { ...process.env };

beforeEach(() => {
	rmSync(join(dir, "gh"), { recursive: true, force: true });
	rmSync(join(dir, "claude"), { recursive: true, force: true });
	spawnSync("mkdir", ["-p", join(dir, "gh")]);
	process.env.SERENITY_FAKE_GH_DIR = join(dir, "gh");
	process.env.SERENITY_FAKE_GH_LOGIN = "sam-demo";
	process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
	process.env.SERENITY_FAKE_MCP_LOGIN_MS = "0";
});

afterAll(() => {
	process.env = saved;
	rmSync(dir, { recursive: true, force: true });
});

const claude = (...args: string[]) =>
	spawnSync(FAKE_CLAUDE[0] as string, [...FAKE_CLAUDE.slice(1), ...args], {
		cwd: workers,
		encoding: "utf8",
	});

test("GitHub: connected as the gh account", async () => {
	expect(await githubStatus(FAKE_GH)).toEqual({
		id: "github",
		connected: true,
		user: "sam-demo",
		problem: null,
	});
});

test("GitHub: not logged in, or gh missing", async () => {
	writeFileSync(join(dir, "gh", "logged-out"), "");
	expect(await githubStatus(FAKE_GH)).toMatchObject({
		connected: false,
		problem: "not logged in",
	});
	expect(await githubStatus(join(dir, "no-such-gh"))).toMatchObject({
		connected: false,
		problem: "gh is not installed (brew install gh)",
	});
});

test("Slack: not set up, then needs a login, then connected", async () => {
	const check = { claude: FAKE_CLAUDE, workers, on: false, user: "Sam" };
	expect((await slackLogin(FAKE_CLAUDE, workers)).login).toBe("missing");
	expect(await slackStatus(check)).toEqual({
		id: "slack",
		connected: false,
		user: null,
		on: false,
		problem: "not connected",
	});

	claude("mcp", "add-json", "-s", "local", "slack", "{}");
	expect(await slackStatus(check)).toMatchObject({
		connected: false,
		problem: "needs a login",
	});

	claude("mcp", "login", "slack");
	expect(await slackStatus({ ...check, on: true })).toEqual({
		id: "slack",
		connected: true,
		user: "Sam",
		on: true,
		problem: null,
	});
});

test("Slack: claude missing is a problem, not a crash", async () => {
	expect(
		await slackStatus({
			claude: [join(dir, "no-such-claude")],
			workers,
			on: false,
			user: null,
		}),
	).toMatchObject({ connected: false });
});

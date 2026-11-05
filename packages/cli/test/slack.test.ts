import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnOnHint } from "../src/slack";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

let dir: string;
let repo: string;
let configFile: string;

/** `serenity …` with its own home and config, no daemon running. */
function serenity(args: string[], cwd = repo) {
	return spawnSync(process.execPath, [MAIN, ...args], {
		cwd,
		env: {
			...process.env,
			SERENITY_HOME: join(dir, "home"),
			XDG_CONFIG_HOME: join(dir, "config"),
		},
		encoding: "utf8",
	});
}

const listed = () =>
	JSON.parse(readFileSync(configFile, "utf8")).slack?.repos as string[];

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "serenity-slack-")));
	repo = join(dir, "app");
	mkdirSync(join(repo, "src"), { recursive: true });
	spawnSync("git", ["init", "-q", repo]);
	configFile = join(dir, "config", "serenity", "config.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("on, status and off for the repo you are in, from any folder in it", () => {
	const sub = join(repo, "src");
	expect(serenity(["slack", "status"], sub).stdout).toContain(
		"Slack is off for app. Turn it on with `serenity slack on`",
	);
	const on = serenity(["slack", "on"], sub);
	expect(on.status).toBe(0);
	expect(on.stdout).toContain("Slack is on for app");
	expect(listed()).toEqual([repo]);
	expect(serenity(["slack", "status"]).stdout).toContain("Slack is on for app");
	expect(serenity(["slack", "on"]).stdout).toContain("already on");
	expect(serenity(["slack", "off"]).status).toBe(0);
	expect(listed()).toEqual([]);
});

test("a repo named as an argument; other keys in the file are kept", () => {
	mkdirSync(join(dir, "config", "serenity"), { recursive: true });
	writeFileSync(
		configFile,
		JSON.stringify({ maxTopics: 4, slack: { repos: ["/other"] } }, null, 2),
	);
	expect(serenity(["slack", "on", repo], dir).status).toBe(0);
	const config = JSON.parse(readFileSync(configFile, "utf8"));
	expect(config).toEqual({
		maxTopics: 4,
		slack: { repos: ["/other", repo] },
	});
});

test("outside a git repo it says how to name one", () => {
	const result = serenity(["slack", "on"], dir);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain("serenity slack on <repo>");
});

test("a config.json with a typo is not overwritten", () => {
	mkdirSync(join(dir, "config", "serenity"), { recursive: true });
	writeFileSync(configFile, "{ oops");
	const result = serenity(["slack", "on"]);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain("not valid JSON");
	expect(readFileSync(configFile, "utf8")).toBe("{ oops");
});

test("an unknown slack subcommand prints its usage", () => {
	const result = serenity(["slack", "enable"]);
	expect(result.status).toBe(2);
	expect(result.stderr).toContain("serenity slack on [repo]");
});

test("the hint never names config keys", () => {
	expect(turnOnHint("/x/app")).not.toContain("slack.repos");
	expect(turnOnHint(null)).toContain("serenity slack on");
});

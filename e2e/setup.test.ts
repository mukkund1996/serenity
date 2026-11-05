/**
 * ADR 0065 end to end: on a first boot the map opens the Setup panel. Enter
 * logs in to GitHub in a popup (the fake gh's device flow), then to Slack
 * (the fake claude's `mcp login`), which turns Slack on for the repo. The
 * panel closes onto the tutorial's card, the settings panel shows both
 * logins, `serenity doctor` names them, and the panel doesn't open again.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
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
import { connectDaemon } from "../packages/core/src";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "packages/cli/src/main.ts");
const FAKE = join(ROOT, "e2e/fake-claude.ts");
const FAKE_GH = join(ROOT, "e2e/fake-gh.ts");
const SOCKET = `serenity-setup-e2e-${process.pid}`;
/** The terminal the user looks at: a client attached to the map, in its own tmux. */
const OUTER = `${SOCKET}-client`;
const MAP = "serenity-demo:map";
const TIMEOUT = 60_000;

let dir = "";
let repo = "";
let home = "";
let env: Record<string, string> = {};

function tmux(...args: string[]): string {
	const result = spawnSync("tmux", ["-L", SOCKET, ...args], {
		encoding: "utf8",
	});
	if (result.status !== 0)
		throw new Error(`tmux ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

const outer = (...args: string[]) =>
	spawnSync("tmux", ["-L", OUTER, "-f", "/dev/null", ...args], {
		encoding: "utf8",
	});
/** What the user sees, popups included. */
const terminal = () => outer("capture-pane", "-p", "-t", "client").stdout;
/** What is inside the open panel (between its ║ borders), to match across lines. */
const text = () =>
	terminal()
		.split("\n")
		.map((line) => {
			const from = line.indexOf("║");
			const to = line.lastIndexOf("║");
			return to > from ? line.slice(from + 1, to) : "";
		})
		.join("\n");
/** Keys as the user types them, so they reach a popup too. */
const type = (...keys: string[]) => outer("send-keys", "-t", "client", ...keys);

/** Esc, then wait: a key sent right after it would arrive as Alt+key. */
async function closeSettings(): Promise<void> {
	type("Escape");
	await until(() => !terminal().includes("═ Settings ═"), "settings to close");
}

const serenity = (...args: string[]) =>
	spawnSync(process.execPath, [MAIN, ...args], {
		cwd: repo,
		env: { ...process.env, ...env },
		encoding: "utf8",
	});

async function until<T>(
	check: () => T | Promise<T>,
	what: string,
	timeoutMs = 20_000,
): Promise<NonNullable<T>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await check();
		if (value) return value as NonNullable<T>;
		await Bun.sleep(100);
	}
	throw new Error(`timed out waiting for ${what}; screen was:\n${terminal()}`);
}

async function rpc<T>(
	fn: (peer: NonNullable<Awaited<ReturnType<typeof connectDaemon>>>) => T,
) {
	const peer = await until(() => connectDaemon(home), "the daemon");
	try {
		return await fn(peer);
	} finally {
		peer.close();
	}
}

function openMap(): void {
	const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
	const tui = [...envArgs, "--", process.execPath, MAIN, "tui"];
	if (
		spawnSync("tmux", ["-L", SOCKET, "has-session", "-t", "serenity-demo"])
			.status === 0
	)
		tmux("new-window", "-t", "serenity-demo:", "-n", "map", "-c", repo, ...tui);
	else
		tmux(
			"new-session",
			"-d",
			"-s",
			"serenity-demo",
			"-n",
			"map",
			"-x",
			"120",
			"-y",
			"40",
			"-c",
			repo,
			...tui,
		);
}

beforeAll(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "srsetup-")));
	repo = join(dir, "repos", "demo");
	home = join(dir, "home");
	mkdirSync(repo, { recursive: true });
	mkdirSync(home);
	mkdirSync(join(dir, "gh"));
	// gh starts logged out; Slack's server isn't registered yet.
	writeFileSync(join(dir, "gh", "logged-out"), "");
	writeFileSync(join(dir, "slack.json"), "[]");
	writeFileSync(join(home, ".doctor-ok"), "e2e\n");
	const git = (...args: string[]) =>
		spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git(
		"-c",
		"user.name=e2e",
		"-c",
		"user.email=e2e@example.com",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"init",
	);
	env = {
		SERENITY_HOME: home,
		SERENITY_TMUX_SOCKET: SOCKET,
		SERENITY_CLAUDE_BIN: FAKE,
		SERENITY_SELF: JSON.stringify([process.execPath, MAIN]),
		SERENITY_STARTUP_GRACE_MS: "300",
		SERENITY_WORKER_DEBOUNCE_MS: "100",
		SERENITY_SLACK_POLL_MS: "1000",
		SERENITY_GH_BIN: FAKE_GH,
		SERENITY_FAKE_GH_DIR: join(dir, "gh"),
		SERENITY_FAKE_GH_LOGIN: "sam-demo",
		SERENITY_FAKE_GH_LOGIN_MS: "100",
		SERENITY_FAKE_SLACK: join(dir, "slack.json"),
		SERENITY_FAKE_SLACK_LOGIN: "Sam (Acme)",
		SERENITY_FAKE_MCP_LOGIN_MS: "300",
		XDG_CONFIG_HOME: join(dir, "config"),
		CLAUDE_CONFIG_DIR: join(dir, "claude"),
	};
	openMap();
	outer(
		"new-session",
		"-d",
		"-s",
		"client",
		"-x",
		"120",
		"-y",
		"40",
		`env -u TMUX TERM=xterm-256color tmux -L ${SOCKET} attach -t serenity-demo`,
	);
});

afterAll(() => {
	serenity("stop");
	outer("kill-server");
	spawnSync("tmux", ["-L", SOCKET, "kill-server"]);
	if (process.env.SERENITY_E2E_KEEP) console.log(`kept ${dir}`);
	else if (dir) rmSync(dir, { recursive: true, force: true });
});

test(
	"first boot: the Setup panel logs in to GitHub and Slack in popups, then hands over to the tutorial",
	async () => {
		await until(
			() => /Set up serenity[\s\S]*GitHub\s+○ not logged in/.test(terminal()),
			"the Setup panel with GitHub logged out",
		);
		expect(terminal()).toContain(
			"Slack     ○ not connected · off for this repo",
		);

		// GitHub: the popup runs gh's device flow, which waits for Enter.
		type("Enter");
		await until(
			() => terminal().includes("First copy your one-time code"),
			"gh's device flow in a popup",
		);
		type("Enter");
		await until(
			() => /GitHub\s+✓ connected as sam-demo/.test(terminal()),
			"GitHub connected",
		);

		// Slack is next: its login runs `claude mcp login`, then turns it on here.
		type("Enter");
		await until(
			() => terminal().includes("Logging in to Slack through Claude Code"),
			"Slack's login in a popup",
		);
		await until(
			() =>
				/Slack\s+✓ connected as Sam \(Acme\) · on for this repo/.test(
					terminal(),
				),
			"Slack connected and on, with the name from its first read",
		);
		const config = JSON.parse(
			readFileSync(join(dir, "config", "serenity", "config.json"), "utf8"),
		);
		expect(config.slack.repos).toEqual([repo]);
		expect(await rpc((p) => p.request("setup.pending", {}))).toBe(true);

		// Enter closes it, onto the tutorial's card: Enter again attaches it.
		await until(() => terminal().includes("Enter done"), "every step done");
		type("Enter");
		await until(
			() => !terminal().includes("Set up serenity"),
			"the panel to close",
		);
		expect(await rpc((p) => p.request("setup.pending", {}))).toBe(false);
		type("Enter");
		await until(
			() => tmux("list-panes", "-t", MAP).trim().split("\n").length === 2,
			"the tutorial attached beside the map",
		);
		type("C-q");
		await until(
			() => tmux("list-panes", "-t", MAP).trim().split("\n").length === 1,
			"back on the map",
		);
	},
	TIMEOUT,
);

test(
	"the settings panel shows both logins, and doctor names them",
	async () => {
		type(",");
		await until(
			() =>
				/GITHUB\s+Login\s+✓ connected as sam-demo/.test(text()) &&
				/SLACK\s+Login\s+✓ connected as Sam \(Acme\)\s+This repo\s+on/.test(
					text(),
				),
			"the logins in settings",
		);
		await closeSettings();

		const doctor = serenity("doctor").stdout;
		expect(doctor).toContain("github  connected as sam-demo");
		expect(doctor).toMatch(/slack\s+connected · on for this repo/);
		expect(doctor).not.toMatch(/gh[op]_/);
	},
	TIMEOUT,
);

test(
	"a logged-out step says so and can be done again from settings",
	async () => {
		writeFileSync(join(dir, "gh", "logged-out"), "");
		type(",");
		await until(
			() => /GITHUB\s+Login\s+○ not logged in/.test(text()),
			"GitHub logged out in settings",
		);
		// Up wraps round: Slack's two rows, then GitHub's.
		for (let i = 0; i < 3; i++) {
			type("Up");
			await Bun.sleep(150);
		}
		await until(
			() => /GITHUB\s+› Login/.test(text()),
			"the GitHub row selected",
		);
		type("Enter");
		await until(
			() => terminal().includes("First copy your one-time code"),
			"the login popup from settings",
		);
		type("Enter");
		await until(
			() => /GITHUB\s+› Login\s+✓ connected as sam-demo/.test(text()),
			"GitHub connected again",
		);
		await closeSettings();
	},
	TIMEOUT,
);

test(
	"the Setup panel doesn't open again on the next map",
	async () => {
		tmux("kill-window", "-t", MAP);
		openMap();
		await until(() => terminal().includes("learn-serenity"), "the map again");
		await Bun.sleep(1500);
		expect(terminal()).not.toContain("Set up serenity");
	},
	TIMEOUT,
);

/**
 * Milestone 1 end to end (ADR 0013): daemon + TUI in a private tmux server,
 * sessions run the fake claude, keys are driven with send-keys and the
 * screen is read with capture-pane.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "packages/cli/src/main.ts");
const FAKE = join(ROOT, "e2e/fake-claude.ts");
const SOCKET = `serenity-e2e-${process.pid}`;
const MAP = "serenity-demo:map";
const STEP_TIMEOUT = 20_000;

let dir = "";
let repo = "";
let env: Record<string, string> = {};

function tmux(...args: string[]): string {
	const result = spawnSync("tmux", ["-L", SOCKET, ...args], {
		encoding: "utf8",
	});
	if (result.status !== 0)
		throw new Error(`tmux ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

const keys = (...k: string[]) => tmux("send-keys", "-t", MAP, ...k);
const type = (text: string) => tmux("send-keys", "-t", MAP, "-l", text);
const screen = (target = MAP) => tmux("capture-pane", "-p", "-t", target);
const panesInMap = () =>
	tmux("list-panes", "-t", MAP, "-F", "#{pane_id}").trim().split("\n");

async function waitFor(
	pattern: RegExp,
	target = MAP,
	timeoutMs = 10_000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let last = "";
	while (Date.now() < deadline) {
		last = screen(target);
		if (pattern.test(last)) return last;
		await Bun.sleep(100);
	}
	throw new Error(`timed out waiting for ${pattern}; screen was:\n${last}`);
}

async function until(
	check: () => boolean,
	what: string,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await Bun.sleep(100);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Types a line into an agent's own pane, as if typed in Claude. */
function typeInAgent(name: string, text: string): void {
	tmux("send-keys", "-t", `serenity-demo:${name}`, "-l", text);
	tmux("send-keys", "-t", `serenity-demo:${name}`, "Enter");
}

const endedCards = () => (screen().match(/Session ended\./g) ?? []).length;

async function newSession(name: string): Promise<void> {
	keys("n");
	await waitFor(/New session/);
	type(name);
	await Bun.sleep(100);
	keys("Enter");
	await until(
		() =>
			tmux("list-windows", "-t", "=serenity-demo", "-F", "#{window_name}")
				.split("\n")
				.includes(name),
		`a window for ${name}`,
	);
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "sre2e-"));
	repo = join(dir, "repos", "demo");
	const home = join(dir, "home");
	mkdirSync(repo, { recursive: true });
	mkdirSync(home);
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
	};
	const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
	tmux(
		"new-session",
		"-d",
		"-s",
		"serenity-demo",
		"-n",
		"map",
		"-x",
		"200",
		"-y",
		"50",
		"-c",
		repo,
		...envArgs,
		"--",
		process.execPath,
		MAIN,
		"tui",
	);
});

afterAll(() => {
	spawnSync(process.execPath, [MAIN, "stop"], {
		env: { ...process.env, ...env },
	});
	spawnSync("tmux", ["-L", SOCKET, "kill-server"]);
	if (dir) rmSync(dir, { recursive: true, force: true });
});

test(
	"first launch starts the daemon and shows the empty master",
	async () => {
		await waitFor(/No sessions yet/);
		expect(screen()).toContain("Press n to start your first session");
	},
	STEP_TIMEOUT,
);

test(
	"n creates a session in a worktree beside the repo",
	async () => {
		keys("n");
		await waitFor(/New session/);
		type("api-auth");
		await Bun.sleep(100);
		keys("Enter");
		await waitFor(/Press i to send a first/);
		expect(screen()).toContain("api-auth");
		expect(existsSync(join(dir, "repos", "demo-api-auth"))).toBe(true);
	},
	STEP_TIMEOUT,
);

test(
	"a reply reaches the agent and its hooks update the card",
	async () => {
		keys("i");
		// Text and Enter in one burst, the way a paste arrives.
		type("rotate tokens\r");
		await waitFor(/Done: rotate tokens/);
		expect(screen()).toContain('you › "rotate tokens"');
	},
	STEP_TIMEOUT,
);

test(
	"a permission prompt shows as waiting everywhere, and clears when answered",
	async () => {
		keys("i");
		type("needs permission\r");
		const waiting = await waitFor(/WAITING/);
		expect(waiting).toContain("1 need you");
		expect(waiting).toContain("NEEDS YOU 1");
		expect(waiting).toContain("Claude needs your permission to use Bash");

		keys("i");
		type("yes\r");
		const done = await waitFor(/Ran it\./);
		expect(done).not.toContain("WAITING");
	},
	STEP_TIMEOUT,
);

test(
	"Enter attaches the session beside the map; the Ctrl+g command detaches it",
	async () => {
		keys("Enter");
		await until(
			() => panesInMap().length === 2,
			"the agent pane to join the map window",
		);
		const [mapPane, agentPane] = panesInMap() as [string, string];
		await waitFor(/Ctrl\+g map/, mapPane);
		expect(screen(mapPane)).toContain("ABOUT THIS SESSION");
		expect(tmux("list-keys", "-T", "root", "C-g")).toContain("detach");

		// send-keys bypasses key bindings, so run what the binding runs.
		spawnSync(process.execPath, [MAIN, "detach", agentPane], {
			env: { ...process.env, ...env },
		});
		await until(
			() => panesInMap().length === 1,
			"the agent pane to be parked again",
		);
		await waitFor(/zoom: topics/);
	},
	STEP_TIMEOUT,
);

test(
	"a session stuck on Claude's trust prompt shows as waiting; answering starts it",
	async () => {
		await newSession("a-untrusted");
		await waitFor(/confirm Claude's startup prompt/);
		expect(screen()).toContain("WAITING");
		typeInAgent("a-untrusted", "y");
		await until(
			() => !screen().includes("confirm Claude's startup prompt"),
			"the startup ask to clear",
		);
	},
	STEP_TIMEOUT,
);

test(
	"refusing the trust prompt ends the session instead of leaving it live",
	async () => {
		await newSession("b-untrusted");
		typeInAgent("b-untrusted", "n");
		await until(() => endedCards() === 1, "b-untrusted to show as ended");
	},
	STEP_TIMEOUT,
);

test(
	"a crash with no SessionEnd hook is shown as ended",
	async () => {
		typeInAgent("a-untrusted", "crash");
		await until(() => endedCards() === 2, "a-untrusted to show as ended");
	},
	STEP_TIMEOUT,
);

test(
	"an agent that exits normally is shown as ended",
	async () => {
		typeInAgent("api-auth", "exit");
		await until(() => endedCards() === 3, "api-auth to show as ended");
	},
	STEP_TIMEOUT,
);

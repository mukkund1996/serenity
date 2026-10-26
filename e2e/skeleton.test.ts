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
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "packages/cli/src/main.ts");
const FAKE = join(ROOT, "e2e/fake-claude.ts");
const FAKE_GH = join(ROOT, "e2e/fake-gh.ts");
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
	// N, not n: n declines a suggestion on the focused node (ADR 0012).
	keys("N");
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
	// The window appears before the dialog closes; keys typed earlier land in it.
	await until(() => !screen().includes("Working dir"), "the dialog to close");
}

/** Where the fake gh reads PR fixtures (<branch>.json) and logs edits. */
const ghDir = () => join(dir, "gh");

/** Commits in a worktree with a throwaway identity; returns the new commit. */
function commitIn(worktree: string, file: string): string {
	writeFileSync(join(worktree, file), `${file}\n`);
	const git = (...args: string[]) =>
		spawnSync(
			"git",
			[
				"-C",
				worktree,
				"-c",
				"user.name=e2e",
				"-c",
				"user.email=e2e@example.com",
				...args,
			],
			{
				encoding: "utf8",
			},
		);
	git("add", file);
	git("commit", "-q", "-m", file);
	return git("rev-parse", "HEAD").stdout.trim();
}

/** Cleanup deletes the branch after it removes the worktree. */
const hasBranch = (name: string) =>
	spawnSync("git", ["-C", repo, "branch", "--list", name], {
		encoding: "utf8",
	}).stdout.trim() !== "";

function writePr(branch: string, pr: Record<string, unknown>): void {
	writeFileSync(join(ghDir(), `${branch}.json`), JSON.stringify(pr));
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "sre2e-"));
	repo = join(dir, "repos", "demo");
	const home = join(dir, "home");
	mkdirSync(repo, { recursive: true });
	mkdirSync(home);
	mkdirSync(join(dir, "gh"));
	writeFileSync(join(home, ".doctor-ok"), "e2e\n");
	const git = (...args: string[]) =>
		spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q", "-b", "main");
	mkdirSync(join(repo, ".github"));
	writeFileSync(join(repo, ".github", "CODEOWNERS"), "* @alice\n");
	git("add", ".");
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
		SERENITY_GH_BIN: FAKE_GH,
		SERENITY_FAKE_GH_DIR: ghDir(),
		CLAUDE_CONFIG_DIR: join(dir, "claude"),
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
	// SERENITY_E2E_KEEP=1 keeps the temp dir (daemon.log, the db) for debugging.
	if (process.env.SERENITY_E2E_KEEP) console.log(`kept ${dir}`);
	else if (dir) rmSync(dir, { recursive: true, force: true });
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
	"a reply reaches the agent; Haiku summarises it and Sonnet suggests a cleanup",
	async () => {
		keys("i");
		// Text and Enter in one burst, the way a paste arrives.
		type("rotate tokens\r");
		const done = await waitFor(/Summary: Done: rotate tokens/);
		expect(done).toContain("✓ api-auth");
		expect(done).toContain("backend ·");
		await waitFor(/◆ Clean up the worktree/);
	},
	STEP_TIMEOUT,
);

test(
	"a permission prompt waits, the master suggests approving, and y approves it",
	async () => {
		keys("i");
		type("needs permission\r");
		const waiting = await waitFor(/WAITING/);
		expect(waiting).toContain("1 need you");
		expect(waiting).toContain("wants to run touch x");
		await waitFor(/◆ Approve: run it/);
		keys("y");
		const after = await waitFor(/Summary: Ran it\./);
		expect(after).not.toContain("WAITING");
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
	"g messages the master; its reply shows in the conversation",
	async () => {
		keys("g");
		type("status?\r");
		const chat = await waitFor(/Heard: status\?/);
		expect(chat).toMatch(/you\s+status\?/);
	},
	STEP_TIMEOUT,
);

test(
	"the master's suggest tool reaches NEEDS YOU through serenity mcp; n declines it",
	async () => {
		keys("g");
		type("suggest a reply to api-auth\r");
		await waitFor(/◆ Reply "ok"/);
		keys("n");
		await until(
			() => !screen().includes('◆ Reply "ok"'),
			"the suggestion to go",
		);
	},
	STEP_TIMEOUT,
);

test(
	"the master's permission request waits at the top of NEEDS YOU until y",
	async () => {
		keys("g");
		type("ask permission\r");
		const asking = await waitFor(/master wants to use Bash/);
		expect(asking).toContain("npm test");
		keys("Tab");
		await waitFor(/▸ ◆ master wants to use Bash/);
		keys("y");
		await waitFor(/Permission: allow/);
		expect(screen()).not.toContain("master wants to use Bash");
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

test(
	"y on a cleanup suggestion stops the session, removes its worktree and merged branch",
	async () => {
		await newSession("tidy");
		keys("i");
		type("finish\r");
		await waitFor(/◆ Clean up the worktree/);
		keys("y");
		await until(
			() => !existsSync(join(dir, "repos", "demo-tidy")),
			"the tidy worktree to be removed",
		);
		await until(() => !hasBranch("tidy"), "the tidy branch to be deleted");
		// Archived sessions leave the map; H lists them under their topic.
		await until(
			() => !screen().includes("Done: finish"),
			"tidy to leave the map",
		);
		keys("H");
		await waitFor(/tidy · tidy · Summary: Done: finish/);
		keys("Escape");
		await until(() => !screen().includes("Archived"), "the list to close");
	},
	STEP_TIMEOUT,
);

test(
	"K kills a session but keeps its worktree; it moves to the archived list",
	async () => {
		await newSession("doomed");
		keys("K");
		await waitFor(/Kill doomed\?/);
		keys("y");
		await until(
			() =>
				!tmux("list-windows", "-t", "=serenity-demo", "-F", "#{window_name}")
					.split("\n")
					.includes("doomed"),
			"the doomed window to close",
		);
		await until(() => !screen().includes("doomed"), "doomed to leave the map");
		expect(existsSync(join(dir, "repos", "demo-doomed"))).toBe(true);
		keys("H");
		await waitFor(/doomed · doomed/);
		keys("Escape");
		await until(() => !screen().includes("Archived"), "the list to close");
	},
	STEP_TIMEOUT,
);

test(
	"a ready PR gets a reviewer from CODEOWNERS; y asks them through gh",
	async () => {
		await newSession("shipit");
		writePr("shipit", {
			number: 7,
			url: "https://github.com/o/demo/pull/7",
			title: "Ship it",
			state: "OPEN",
			isDraft: false,
			statusCheckRollup: [
				{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
			],
			reviewDecision: "REVIEW_REQUIRED",
			reviewRequests: [],
			latestReviews: [],
			author: { login: "me" },
			headRefOid: "0",
			baseRefName: "main",
			files: [{ path: "src/x.ts" }],
		});
		keys("i");
		type("open the pr\r");
		await waitFor(/PR #7 checks passing/);
		await waitFor(/◆ Request review from @alice/);
		keys("y");
		await until(
			() =>
				existsSync(join(ghDir(), "edits.log")) &&
				readFileSync(join(ghDir(), "edits.log"), "utf8") === "7 alice\n",
			"gh to be asked for alice",
		);
		await until(
			() => !screen().includes("Request review"),
			"the review suggestion to go",
		);
	},
	STEP_TIMEOUT,
);

test(
	"a squash-merged PR finishes the session; cleanup deletes the branch git calls unmerged",
	async () => {
		const worktree = join(dir, "repos", "demo-shipit");
		const head = commitIn(worktree, "feature.txt");
		const pr = JSON.parse(readFileSync(join(ghDir(), "shipit.json"), "utf8"));
		writePr("shipit", { ...pr, state: "MERGED", headRefOid: head });
		keys("i");
		type("after merge\r");
		await waitFor(/PR #7 merged/);
		await waitFor(/◆ Clean up the worktree/);
		keys("y");
		await until(
			() => !existsSync(worktree),
			"the shipit worktree to be removed",
		);
		await until(() => !hasBranch("shipit"), "the shipit branch to be deleted");
	},
	STEP_TIMEOUT,
);

/** A claude the user started in their own tmux session, without serenity. */
const MINE = "mywork:polish";

test(
	"I imports a claude already running in the user's own tmux window",
	async () => {
		tmux(
			"new-session",
			"-d",
			"-s",
			"mywork",
			"-n",
			"polish",
			"-c",
			repo,
			"-e",
			`CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR}`,
			"--",
			process.execPath,
			FAKE,
		);
		await waitFor(/fake claude ready/, MINE);
		keys("I");
		await waitFor(/Import sessions/);
		await waitFor(/\[x\] +polish/);
		keys("Enter");
		await waitFor(/imported 1 session/);
		// It stays in the user's window: nothing moved into serenity's session.
		expect(
			tmux("list-windows", "-t", "=mywork", "-F", "#{window_name}").trim(),
		).toBe("polish");
	},
	STEP_TIMEOUT,
);

test(
	"an imported session follows Claude's own status, permission prompts included",
	async () => {
		tmux("send-keys", "-t", MINE, "-l", "tidy the cards?");
		tmux("send-keys", "-t", MINE, "Enter");
		// Its card sits behind "+1 more"; NEEDS YOU shows it either way.
		await waitFor(/◐ polish[^\n]*\n[^\n]*Should I tidy the cards\?/);
		tmux("send-keys", "-t", MINE, "-l", "permission please");
		tmux("send-keys", "-t", MINE, "Enter");
		await waitFor(/wants to run touch x/);
		await waitFor(/◆ Approve: run it/);
		keys("y");
		await waitFor(/approved/, MINE);
		await until(
			() => !screen().includes("Approve: run it"),
			"the approval to be used",
		);
	},
	STEP_TIMEOUT,
);

test(
	"U restarts an imported session in place under serenity's hooks",
	async () => {
		const pane = tmux("display-message", "-p", "-t", MINE, "#{pane_id}").trim();
		keys("U");
		await waitFor(/restarted polish with full tracking/);
		await waitFor(/fake claude ready/, MINE);
		expect(tmux("display-message", "-p", "-t", MINE, "#{pane_id}").trim()).toBe(
			pane,
		);
		tmux("send-keys", "-t", MINE, "-l", "via hooks now");
		tmux("send-keys", "-t", MINE, "Enter");
		await waitFor(/✓ polish/);
	},
	STEP_TIMEOUT,
);

test(
	"Z opens the map zoom, z goes back to topics, Esc zooms out one level",
	async () => {
		keys("Z");
		const map = await waitFor(/zoom: map/);
		expect(map).toContain("◆ master");
		expect(map).toMatch(/polish/);
		expect(map).not.toContain("no PR yet");
		// The map is the top level; Esc stays there.
		keys("Escape");
		await Bun.sleep(200);
		expect(screen()).toContain("zoom: map");
		keys("z");
		await waitFor(/zoom: topics/);
		keys("Escape");
		await waitFor(/zoom: map/);
		keys("z");
		await waitFor(/zoom: topics/);
	},
	STEP_TIMEOUT,
);

test(
	"/ finds a session by name; r renames it and its tmux window",
	async () => {
		const windows = () =>
			tmux("list-windows", "-t", "=serenity-demo", "-F", "#{window_name}")
				.trim()
				.split("\n");
		await newSession("oldname");
		keys("c");
		await waitFor(/┏/);
		keys("/");
		await waitFor(/name, topic or branch/);
		type("oldn");
		await waitFor(/1 of 1/);
		keys("Enter");
		await until(() => !screen().includes("1 of 1"), "the search to close");
		keys("r");
		await waitFor(/Rename oldname/);
		keys("C-u");
		type("newname");
		await Bun.sleep(100);
		keys("Enter");
		await until(
			() => windows().includes("newname") && !windows().includes("oldname"),
			"the window to be renamed",
		);
		await until(
			() => screen().includes("newname") && !screen().includes("oldname"),
			"the card to show the new name",
		);
	},
	STEP_TIMEOUT,
);

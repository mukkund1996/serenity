import { describe, expect, test } from "bun:test";
import {
	adoptedName,
	type ClaudeProcess,
	parseClaudeProcess,
	permissionPrompt,
	readTranscriptTail,
	reconcileHooked,
	reduceObserved,
	STARTUP_ASK,
	transcriptPathFor,
} from "../src";
import { makeSession } from "../test-support";

const file = {
	pid: 30351,
	sessionId: "9eb42c8d",
	cwd: "/Users/me/projects/perry-poc",
	kind: "interactive",
	tmux: "guide:@166.%258",
	name: "perry-poc-7a",
	status: "busy",
};

const proc = (overrides: Partial<ClaudeProcess> = {}): ClaudeProcess => ({
	pid: 7,
	sessionId: "c1",
	cwd: "/repos/demo",
	pane: "%9",
	name: null,
	status: "idle",
	waitingFor: null,
	statusAt: null,
	...overrides,
});

const tail = (overrides = {}) => ({
	title: null,
	lastPrompt: null,
	lastReply: null,
	branch: null,
	...overrides,
});

describe("parseClaudeProcess", () => {
	test("reads an interactive claude in tmux", () => {
		expect(parseClaudeProcess(file)).toEqual({
			pid: 30351,
			sessionId: "9eb42c8d",
			cwd: "/Users/me/projects/perry-poc",
			pane: "%258",
			name: "perry-poc-7a",
			status: "busy",
			waitingFor: null,
			statusAt: null,
		});
	});

	test("skips background sessions, claudes outside tmux and junk", () => {
		expect(parseClaudeProcess({ ...file, kind: "bg" })).toBeNull();
		expect(parseClaudeProcess({ ...file, tmux: undefined })).toBeNull();
		expect(parseClaudeProcess("nope")).toBeNull();
	});
});

test("transcript paths follow Claude Code's project folders", () => {
	expect(transcriptPathFor("/h/.claude", "/Users/me/perry-poc", "abc")).toBe(
		"/h/.claude/projects/-Users-me-perry-poc/abc.jsonl",
	);
});

describe("readTranscriptTail", () => {
	const lines = [
		'ial line cut by the tail read"}',
		JSON.stringify({ type: "ai-title", aiTitle: "Dump mode PR" }),
		JSON.stringify({ type: "last-prompt", lastPrompt: "open the PR" }),
		JSON.stringify({
			type: "assistant",
			gitBranch: "feature/dump",
			message: { content: [{ type: "text", text: "Opened #3311." }] },
		}),
		JSON.stringify({
			type: "assistant",
			isSidechain: true,
			message: { content: [{ type: "text", text: "subagent chatter" }] },
		}),
		JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "tool_use", name: "Bash" }] },
		}),
	];

	test("finds the title, last prompt, last reply and branch", () => {
		expect(readTranscriptTail(lines.join("\n"))).toEqual({
			title: "Dump mode PR",
			lastPrompt: "open the PR",
			lastReply: "Opened #3311.",
			branch: "feature/dump",
		});
	});

	test("a title the user set wins over Claude's", () => {
		const text = [
			...lines,
			JSON.stringify({ type: "custom-title", customTitle: "mine" }),
		].join("\n");
		expect(readTranscriptTail(text).title).toBe("mine");
	});
});

describe("permissionPrompt", () => {
	test("a Bash prompt names the command", () => {
		const screen =
			"stuff\n Bash command\n\n   touch x\n   Create a file\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n";
		expect(permissionPrompt(screen)).toBe("wants to run touch x");
	});

	test("box borders around the dialog are ignored", () => {
		const screen =
			"│ Bash command                │\n│   rm -rf dist               │\n│ ❯ 1. Yes                    │\n";
		expect(permissionPrompt(screen)).toBe("wants to run rm -rf dist");
	});

	test("other prompts use their question", () => {
		expect(
			permissionPrompt("Do you want to make this edit to a.ts?\n❯ 1. Yes\n"),
		).toBe("Do you want to make this edit to a.ts?");
	});

	test("no numbered Yes, no prompt", () => {
		expect(permissionPrompt("Should I continue?\n> ")).toBeNull();
	});
});

describe("reduceObserved", () => {
	test("busy is working, with the prompt and no stale reply", () => {
		const session = makeSession({ lastAssistantMessage: "old" });
		expect(
			reduceObserved(session, {
				process: proc({ status: "busy" }),
				tail: tail({ lastPrompt: "fix it", lastReply: "old" }),
				permission: null,
			}),
		).toEqual({
			claudePid: 7,
			status: "working",
			lastPrompt: "fix it",
			lastAssistantMessage: null,
		});
	});

	test("idle carries the last reply, which starts a summary", () => {
		const patch = reduceObserved(makeSession({ status: "working" }), {
			process: proc(),
			tail: tail({ lastReply: "Done." }),
			permission: null,
		});
		expect(patch).toMatchObject({
			status: "idle",
			lastAssistantMessage: "Done.",
		});
	});

	test("waiting on a permission prompt can be approved", () => {
		const patch = reduceObserved(makeSession({ status: "working" }), {
			process: proc({ status: "waiting", waitingFor: "dialog open" }),
			tail: tail(),
			permission: "wants to run touch x",
		});
		expect(patch).toMatchObject({
			status: "waiting",
			waitingOn: "permission",
			ask: "wants to run touch x",
		});
	});

	test("other waits are questions; an untrusted folder is startup", () => {
		expect(
			reduceObserved(makeSession(), {
				process: proc({ status: "waiting", waitingFor: "input needed" }),
				tail: tail(),
				permission: null,
			}),
		).toMatchObject({ waitingOn: "question", ask: "input needed" });
		expect(
			reduceObserved(makeSession(), {
				process: proc({ status: "needs_trust" }),
				tail: tail(),
				permission: null,
			}),
		).toMatchObject({ waitingOn: "startup", ask: STARTUP_ASK });
	});

	test("finished stays finished until a new reply; archived is sticky", () => {
		const done = makeSession({
			status: "done",
			lastAssistantMessage: "Done.",
			claudePid: 7,
		});
		const idle = { process: proc(), permission: null };
		expect(
			reduceObserved(done, { ...idle, tail: tail({ lastReply: "Done." }) }),
		).toEqual({});
		expect(
			reduceObserved(done, { ...idle, tail: tail({ lastReply: "More." }) }),
		).toMatchObject({ status: "idle" });
		expect(
			reduceObserved(makeSession({ status: "archived", claudePid: 7 }), {
				...idle,
				process: proc({ status: "busy" }),
				tail: tail(),
			}),
		).toEqual({});
	});
});

describe("reconcileHooked", () => {
	const hooked = (overrides: Partial<Parameters<typeof makeSession>[0]>) =>
		makeSession({ tracking: "hooks", ...overrides });

	test("an interrupted turn (no Stop hook) goes idle once Claude's idle has held", () => {
		const working = hooked({ status: "working" });
		const claude = proc({ status: "idle", statusAt: 5000 });
		expect(reconcileHooked(working, claude, 4000, 5400)).toEqual({
			patch: {},
			wait: 600,
		});
		expect(reconcileHooked(working, claude, 4000, 6000)).toEqual({
			patch: { status: "idle", ask: null, waitingOn: null },
			wait: 0,
		});
	});

	test("a prompt answered in the pane is working again before the tool finishes", () => {
		const waiting = hooked({
			status: "waiting",
			waitingOn: "permission",
			ask: "wants to run make",
		});
		expect(
			reconcileHooked(
				waiting,
				proc({ status: "busy", statusAt: 5000 }),
				4000,
				7000,
			).patch,
		).toEqual({ status: "working", ask: null, waitingOn: null });
	});

	test("hooks newer than Claude's status win, and so do running subagents", () => {
		const working = hooked({ status: "working" });
		const idle = proc({ status: "idle", statusAt: 5000 });
		expect(reconcileHooked(working, idle, 5000, 9000).patch).toEqual({});
		expect(
			reconcileHooked(
				hooked({ status: "working", subagents: ["a1"] }),
				idle,
				0,
				9000,
			).patch,
		).toEqual({});
		expect(
			reconcileHooked(
				working,
				proc({ status: "idle", statusAt: null }),
				0,
				9000,
			).patch,
		).toEqual({});
	});

	test("leaves agreeing, finished and archived sessions alone", () => {
		const idle = proc({ status: "idle", statusAt: 5000 });
		for (const status of ["idle", "done", "archived", "dead"] as const)
			expect(reconcileHooked(hooked({ status }), idle, 0, 9000).patch).toEqual(
				{},
			);
		expect(
			reconcileHooked(
				hooked({ status: "working" }),
				proc({ status: "busy", statusAt: 5000 }),
				0,
				9000,
			).patch,
		).toEqual({});
	});
});

describe("adoptedName", () => {
	test("prefers the tmux window, skipping automatic names", () => {
		expect(adoptedName(["dump-mode-fe", "Title"], new Set())).toBe(
			"dump-mode-fe",
		);
		expect(adoptedName(["2.1.309", "Variant 3 dump-mode PR!"], new Set())).toBe(
			"variant-3-dump-mode-pr",
		);
		expect(adoptedName(["zsh", null, "perry-poc-7a"], new Set())).toBe(
			"perry-poc-7a",
		);
	});

	test("never clashes with a name on the map", () => {
		expect(adoptedName(["polish"], new Set(["polish", "polish-2"]))).toBe(
			"polish-3",
		);
		expect(adoptedName([null], new Set())).toBe("session");
	});

	test("never takes a master command word (ADR 0048)", () => {
		expect(adoptedName(["New"], new Set())).toBe("new-2");
		expect(adoptedName(["new"], new Set(["new-2"]))).toBe("new-3");
	});
});

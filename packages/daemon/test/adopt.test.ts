import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createMemoryStorage,
	type Session,
	type Storage,
	transcriptPathFor,
} from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import { ClaudeObserver } from "../src/adopt";
import { Tmux } from "../src/tmux";

class FakeTmux extends Tmux {
	panes = new Map<string, { session: string; window: string; name: string }>();
	screen = "";
	options = new Map<string, string>();
	override async paneExists(pane: string) {
		return this.panes.has(pane);
	}
	override async describePane(pane: string) {
		const p = this.panes.get(pane);
		return {
			session: p?.session ?? "",
			window: p?.window ?? "",
			windowName: p?.name ?? "",
		};
	}
	override async capturePane() {
		return this.screen;
	}
	override async setPaneOption(pane: string, _option: string, value: string) {
		this.options.set(pane, value);
		return "";
	}
	override async unsetPaneOption(pane: string) {
		this.options.delete(pane);
		return "";
	}
}

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sadopt-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function gitRepo(path: string): string {
	mkdirSync(path, { recursive: true });
	spawnSync("git", ["init", "-q", "-b", "main", path]);
	spawnSync("git", [
		"-C",
		path,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@example.com",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"init",
	]);
	return path;
}
const repo = gitRepo(join(dir, "demo"));
const other = gitRepo(join(dir, "other"));
const config = join(dir, "claude");
mkdirSync(join(config, "sessions"), { recursive: true });

/** A live pid to stand for claude: this test process. */
const PID = process.pid;

function writeProcess(fields: Record<string, unknown>): void {
	writeFileSync(
		join(config, "sessions", `${fields.pid}.json`),
		JSON.stringify({
			kind: "interactive",
			sessionId: "c1",
			cwd: repo,
			tmux: "work:@3.%7",
			status: "idle",
			...fields,
		}),
	);
}

function writeTranscript(cwd: string, id: string, lines: object[]): void {
	const path = transcriptPathFor(config, cwd, id);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
}

let storage: Storage;
let tmux: FakeTmux;
let ended: string[];
let observer: ClaudeObserver;

beforeEach(() => {
	rmSync(join(config, "sessions"), { recursive: true, force: true });
	mkdirSync(join(config, "sessions"));
	storage = createMemoryStorage();
	tmux = new FakeTmux();
	tmux.panes.set("%7", { session: "work", window: "1", name: "polish" });
	ended = [];
	observer = new ClaudeObserver(
		{
			storage,
			tmux,
			now: () => 1,
			change: (session, patch) => {
				const next = { ...session, ...patch };
				storage.sessions.put(next);
				return next;
			},
			broadcast: () => {},
			markEnded: (session) => {
				ended.push(session.name);
				storage.sessions.put({ ...session, status: "dead" });
			},
			bindDetachKey: async () => {},
			log: () => {},
		},
		config,
	);
});

describe("ClaudeObserver", () => {
	test("finds claudes in this repo's tmux panes, named after their window", async () => {
		writeProcess({ pid: PID });
		writeTranscript(repo, "c1", [
			{ type: "ai-title", aiTitle: "Polish the cards" },
			{ type: "last-prompt", lastPrompt: "tighten spacing" },
		]);
		expect(await observer.candidates(repo)).toEqual([
			{
				claudeSessionId: "c1",
				pid: PID,
				tmuxPane: "%7",
				location: "work:1 polish",
				name: "polish",
				title: "Polish the cards",
				lastPrompt: "tighten spacing",
				cwd: repo,
				branch: "main",
				status: "idle",
			},
		]);
	});

	test("skips other repos, dead processes, unknown panes and tracked sessions", async () => {
		writeProcess({ pid: PID, cwd: other });
		expect(await observer.candidates(repo)).toEqual([]);
		writeProcess({ pid: 999_999_999 });
		expect(await observer.candidates(repo)).toEqual([]);
		writeProcess({ pid: PID, tmux: "work:@3.%8" });
		expect(await observer.candidates(repo)).toEqual([]);
		writeProcess({ pid: PID });
		storage.sessions.put(makeSession({ repo, tmuxPane: "%7" }));
		expect(await observer.candidates(repo)).toEqual([]);
	});

	test("adopting marks the pane and reads the current state", async () => {
		writeProcess({ pid: PID, status: "busy" });
		writeTranscript(repo, "c1", [
			{ type: "last-prompt", lastPrompt: "tighten spacing" },
		]);
		const [session] = await observer.adopt(repo, ["c1"]);
		expect(session).toMatchObject({
			name: "polish",
			origin: "adopted",
			tracking: "observed",
			claudePid: PID,
			status: "working",
			lastPrompt: "tighten spacing",
			worktree: null,
			ownsBranch: false,
		});
		expect(tmux.options.get("%7")).toBe((session as Session).id);
	});

	test("a finished turn and a permission prompt come through", async () => {
		writeProcess({ pid: PID, status: "busy" });
		const [adopted] = await observer.adopt(repo, ["c1"]);
		const id = (adopted as Session).id;

		writeProcess({ pid: PID, status: "idle" });
		writeTranscript(repo, "c1", [
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "Spacing fixed." }] },
			},
		]);
		await observer.sweep();
		expect(storage.sessions.get(id)).toMatchObject({
			status: "idle",
			lastAssistantMessage: "Spacing fixed.",
		});

		tmux.screen =
			" Bash command\n   bun test\n Do you want to proceed?\n ❯ 1. Yes\n";
		writeProcess({ pid: PID, status: "waiting", waitingFor: "dialog open" });
		await observer.sweep();
		expect(storage.sessions.get(id)).toMatchObject({
			status: "waiting",
			waitingOn: "permission",
			ask: "wants to run bun test",
		});
	});

	test("a claude that exits ends its session and frees the pane", async () => {
		writeProcess({ pid: PID });
		await observer.adopt(repo, ["c1"]);
		rmSync(join(config, "sessions", `${PID}.json`));
		await observer.sweep();
		expect(ended).toEqual(["polish"]);
		expect(tmux.options.has("%7")).toBe(false);
	});
});

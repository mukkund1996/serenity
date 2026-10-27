import { beforeEach, expect, test } from "bun:test";
import { SLACK_LOGIN_HINT, SLACK_READ_TOOLS } from "@serenity/core";
import type { ClaudeRunner, JsonRunOptions } from "../src/claude";
import { SlackWatcher } from "../src/slack";

class FakeRunner implements ClaudeRunner {
	calls: JsonRunOptions[] = [];
	answer: unknown = { access: "ok", problem: null, items: [] };
	async runJson(opts: JsonRunOptions): Promise<unknown> {
		this.calls.push(opts);
		if (this.answer instanceof Error) throw this.answer;
		return this.answer;
	}
	startChat(): never {
		throw new Error("no chat");
	}
}

const message = (ts: string) => ({
	channelId: "C1",
	channel: "#eng",
	author: "Ana",
	text: "ping",
	reason: "mention",
	ts,
	threadTs: ts,
	permalink: null,
});

let runner: FakeRunner;
let open: boolean;
let broadcasts: number;
let inboxes: number[];
let now: number;
let watcher: SlackWatcher;

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
	runner = new FakeRunner();
	open = true;
	broadcasts = 0;
	inboxes = [];
	now = 1_000_000;
	watcher?.stop();
	watcher = new SlackWatcher({
		runner,
		model: "haiku",
		cwd: "/w",
		mcpConfig: '{"mcpServers":{"slack":{}}}',
		watching: () => open,
		broadcast: () => broadcasts++,
		onInbox: (items) => inboxes.push(items.length),
		log: () => {},
		now: () => now,
		pollMs: 20,
	});
});

test("opening a map reads Slack with only its read tools", async () => {
	runner.answer = {
		access: "ok",
		problem: null,
		items: [message("1730000000.0")],
	};
	watcher.watch();
	await settle();
	expect(runner.calls).toHaveLength(1);
	expect(runner.calls[0]?.allowedTools).toEqual(SLACK_READ_TOOLS);
	expect(runner.calls[0]?.mcpConfig).toContain("slack");
	expect(watcher.state().items.map((i) => i.id)).toEqual(["C1:1730000000.0"]);
	expect(broadcasts).toBe(1);
	// Opening another map within a minute does not read again.
	watcher.watch();
	await settle();
	expect(runner.calls).toHaveLength(1);
});

test("polls while a map is open and stops when none is", async () => {
	watcher.watch();
	await new Promise((resolve) => setTimeout(resolve, 70));
	const polled = runner.calls.length;
	expect(polled).toBeGreaterThan(1);
	open = false;
	await new Promise((resolve) => setTimeout(resolve, 70));
	expect(runner.calls.length).toBeLessThanOrEqual(polled + 1);
});

test("no login shows the hint; a failed read keeps the last items", async () => {
	runner.answer = { access: "no_access", problem: "401 auth", items: [] };
	await watcher.refresh();
	expect(watcher.state().error).toBe(SLACK_LOGIN_HINT);
	runner.answer = {
		access: "ok",
		problem: null,
		items: [message("1730000000.0")],
	};
	await watcher.refresh();
	expect(watcher.state().error).toBeNull();
	runner.answer = new Error("timed out");
	await watcher.refresh();
	expect(watcher.state().items).toHaveLength(1);
	expect(watcher.state().error).toBe("Slack: timed out");
});

test("an unchanged inbox is not broadcast again", async () => {
	await watcher.refresh();
	now += 1000;
	await watcher.refresh();
	expect(broadcasts).toBe(0);
});

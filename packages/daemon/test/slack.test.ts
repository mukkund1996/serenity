import { beforeEach, expect, test } from "bun:test";
import {
	createMemoryStorage,
	SLACK_LOGIN_HINT,
	SLACK_READ_TOOLS,
	type SlackDismissalStore,
} from "@serenity/core";
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
	action: "Check the deploy",
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
let dismissals: SlackDismissalStore;

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
	runner = new FakeRunner();
	open = true;
	broadcasts = 0;
	inboxes = [];
	now = 1_000_000;
	dismissals = createMemoryStorage().slackDismissals;
	watcher?.stop();
	watcher = makeWatcher();
});

function makeWatcher(): SlackWatcher {
	return new SlackWatcher({
		runner,
		model: "haiku",
		cwd: "/w",
		mcpConfig: '{"mcpServers":{"slack":{}}}',
		dismissals,
		watching: () => open,
		broadcast: () => broadcasts++,
		onInbox: (items) => inboxes.push(items.length),
		log: () => {},
		now: () => now,
		pollMs: 20,
	});
}

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

test("a dismissed item leaves at once and stays gone on the next read", async () => {
	runner.answer = {
		access: "ok",
		problem: null,
		items: [
			message("1730000000.0"),
			{ ...message("1730000100.0"), channelId: "D2" },
		],
	};
	await watcher.refresh();
	expect(watcher.state().items).toHaveLength(2);
	broadcasts = 0;
	inboxes = [];

	watcher.dismiss("C1", "1730000000.0");
	expect(watcher.state().items.map((i) => i.channelId)).toEqual(["D2"]);
	expect(broadcasts).toBe(1);
	// The advisor hears of it, so the item's suggestion goes too.
	expect(inboxes).toEqual([1]);

	// The worker is told to skip it, and it is dropped if it comes back anyway.
	await watcher.refresh();
	expect(runner.calls.at(-1)?.prompt).toContain("C1 1730000000.0");
	expect(watcher.state().items.map((i) => i.channelId)).toEqual(["D2"]);
});

test("a newer message in a dismissed thread shows again", async () => {
	runner.answer = {
		access: "ok",
		problem: null,
		items: [message("1730000000.0")],
	};
	await watcher.refresh();
	watcher.dismiss("C1", "1730000000.0");
	expect(watcher.state().items).toHaveLength(0);
	runner.answer = {
		access: "ok",
		problem: null,
		items: [{ ...message("1730000500.0"), threadTs: "1730000000.0" }],
	};
	await watcher.refresh();
	expect(watcher.state().items.map((i) => i.ts)).toEqual(["1730000500.0"]);
});

test("dismissals persist: a new watcher on the same store still hides them", async () => {
	runner.answer = {
		access: "ok",
		problem: null,
		items: [message("1730000000.0")],
	};
	watcher.dismiss("C1", "1730000000.0");
	watcher.dismiss("C1", "1730000000.0");
	expect(dismissals.list()).toHaveLength(1);
	watcher.stop();
	watcher = makeWatcher();
	await watcher.refresh();
	expect(watcher.state().items).toHaveLength(0);
});

test("dismissing something not shown only records it", () => {
	watcher.dismiss("C9", "1.0");
	expect(broadcasts).toBe(0);
	expect(inboxes).toEqual([]);
	expect(dismissals.list()).toEqual([{ channelId: "C9", ts: "1.0", at: now }]);
});

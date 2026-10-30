import { beforeEach, expect, test } from "bun:test";
import {
	createMemoryStorage,
	type Session,
	SLACK_SEND_TOOL,
	type SlackItem,
	type Storage,
} from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import type { ClaudeRunner, JsonRunOptions } from "../src/claude";
import { SlackAdvisor } from "../src/slack-advisor";

/** Answers JSON calls from a queue, recording each. */
class FakeRunner implements ClaudeRunner {
	answers: unknown[] = [];
	calls: JsonRunOptions[] = [];
	async runJson(opts: JsonRunOptions): Promise<unknown> {
		this.calls.push(opts);
		if (!this.answers.length) throw new Error("no answer queued");
		return this.answers.shift();
	}
	startChat(): never {
		throw new Error("no chat");
	}
}

const REPO = "/repos/demo";
const item: SlackItem = {
	id: "C1:100.0",
	channelId: "C1",
	channel: "#eng",
	author: "Ana",
	text: "did the token fix ship?",
	reason: "mention",
	action: "Check the deploy",
	ts: "100.0",
	threadTs: "100.0",
	permalink: null,
	at: 100_000,
};

let storage: Storage;
let runner: FakeRunner;
let advisor: SlackAdvisor;
let typed: Array<[string, string]>;
let started: Array<[string, string]>;
let refreshes: number;
let session: Session;

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
	storage = createMemoryStorage();
	runner = new FakeRunner();
	typed = [];
	started = [];
	refreshes = 0;
	session = makeSession({
		id: "s1",
		repo: REPO,
		name: "api-auth",
		status: "idle",
		tmuxPane: "%1",
		lastAssistantMessage: "Done with the refactor.",
	});
	storage.sessions.put(session);
	advisor = new SlackAdvisor({
		runner,
		storage,
		model: "sonnet",
		sendModel: "haiku",
		cwd: "/w",
		mcpConfig: "{}",
		reviews: () => [],
		sendText: async (s, text) => {
			typed.push([s.name, text]);
		},
		startSession: async (repo, name, brief) => {
			started.push([name, brief]);
			const fresh = makeSession({
				id: "s9",
				repo,
				name,
				status: "working",
				lastAssistantMessage: null,
			});
			storage.sessions.put(fresh);
			return fresh;
		},
		refreshInbox: () => refreshes++,
		broadcast: () => {},
		log: () => {},
	});
});

test("a new item gets a reply suggestion; y posts exactly that text", async () => {
	runner.answers.push({
		kind: "reply",
		text: "yes, in #42",
		session: "api-auth",
	});
	advisor.onInbox(REPO, [item]);
	await settle();
	expect(advisor.list(REPO)).toMatchObject([
		{ itemId: item.id, kind: "reply", status: "pending" },
	]);
	expect(runner.calls[0]?.prompt).toContain("did the token fix ship?");
	expect(runner.calls[0]?.prompt).toContain("api-auth [unsorted] idle");
	expect(advisor.list(REPO)[0]?.action).toBe("Reply in #eng thread");
	expect(runner.calls[0]?.allowedTools).not.toContain(SLACK_SEND_TOOL);

	// A second read with the same item does not ask the model again.
	advisor.onInbox(REPO, [item]);
	await settle();
	expect(runner.calls).toHaveLength(1);

	runner.answers.push({ sent: true, problem: null });
	await advisor.accept(REPO, item.id, "yes, shipped in #42");
	const send = runner.calls[1];
	expect(send?.allowedTools).toEqual([SLACK_SEND_TOOL]);
	expect(send?.prompt).toContain("<<<\nyes, shipped in #42\n>>>");
	expect(send?.prompt).toContain("thread with ts 100.0 in channel C1");
	expect(advisor.list(REPO)).toEqual([]);
	expect(refreshes).toBe(1);
	// Sent: not suggested again while Slack still lists it.
	advisor.onInbox(REPO, [item]);
	await settle();
	expect(runner.calls).toHaveLength(2);
});

test("a failed send keeps the suggestion to try again", async () => {
	runner.answers.push({
		kind: "reply",
		text: "yes",
		session: null,
	});
	advisor.onInbox(REPO, [item]);
	await settle();
	runner.answers.push({ sent: false, problem: "channel_not_found" });
	await expect(advisor.accept(REPO, item.id)).rejects.toThrow(
		"channel_not_found",
	);
	expect(advisor.list(REPO)[0]?.status).toBe("pending");
});

test("a tell types the message; the session's answer becomes a reply", async () => {
	runner.answers.push({
		kind: "tell",
		text: "Did the token fix ship? Answer in one line.",
		session: "api-auth",
	});
	advisor.onInbox(REPO, [item]);
	await settle();
	await advisor.accept(REPO, item.id);
	expect(typed).toEqual([
		["api-auth", "Did the token fix ship? Answer in one line."],
	]);
	expect(advisor.list(REPO)[0]).toMatchObject({
		status: "asked",
		action: "Told api-auth; waiting for its answer",
	});

	runner.answers.push({
		kind: "reply",
		text: "shipped in #42",
		session: "api-auth",
	});
	// Its own earlier reply is not the answer.
	advisor.onSessionChanged(session);
	await settle();
	expect(runner.calls).toHaveLength(1);
	advisor.onSessionChanged({
		...session,
		lastAssistantMessage: "Yes: merged in #42 this morning.",
	});
	await settle();
	expect(runner.calls[1]?.prompt).toContain(
		"It answered: Yes: merged in #42 this morning.",
	);
	expect(runner.calls[1]?.prompt).not.toContain("- tell:");
	expect(advisor.list(REPO)[0]).toMatchObject({
		kind: "reply",
		status: "pending",
		text: "shipped in #42",
	});
});

test("a start begins a session with the brief; its first answer becomes a reply", async () => {
	runner.answers.push({
		kind: "start",
		text: "Fix the token refresh Ana reported in #eng.",
		session: null,
		name: "fix-token-refresh",
	});
	advisor.onInbox(REPO, [item]);
	await settle();
	expect(advisor.list(REPO)[0]).toMatchObject({
		kind: "start",
		action: "Start new session fix-token-refresh",
		name: "fix-token-refresh",
	});
	await advisor.accept(REPO, item.id);
	expect(started).toEqual([
		["fix-token-refresh", "Fix the token refresh Ana reported in #eng."],
	]);
	expect(typed).toEqual([]);
	expect(advisor.list(REPO)[0]).toMatchObject({
		status: "asked",
		sessionId: "s9",
		action: "Started fix-token-refresh; waiting for its answer",
	});

	runner.answers.push({
		kind: "reply",
		text: "fixed in #43",
		session: "fix-token-refresh",
		name: null,
	});
	const fresh = storage.sessions.get("s9") as Session;
	advisor.onSessionChanged({
		...fresh,
		status: "idle",
		lastAssistantMessage: "Fixed in #43.",
	});
	await settle();
	expect(runner.calls[1]?.prompt).toContain("It answered: Fixed in #43.");
	expect(advisor.list(REPO)[0]).toMatchObject({
		kind: "reply",
		status: "pending",
		text: "fixed in #43",
	});
});

test("n declines until someone writes in the thread again", async () => {
	runner.answers.push({
		kind: "reply",
		text: "yes",
		session: null,
	});
	advisor.onInbox(REPO, [item]);
	await settle();
	advisor.decline(REPO, item.id);
	expect(advisor.list(REPO)).toEqual([]);
	advisor.onInbox(REPO, [item]);
	await settle();
	expect(runner.calls).toHaveLength(1);
	runner.answers.push({ kind: "none", text: null, session: null, name: null });
	advisor.onInbox(REPO, [{ ...item, ts: "200.0", text: "any news?" }]);
	await settle();
	expect(runner.calls).toHaveLength(2);
});

test("an item that left the inbox loses its suggestion", async () => {
	runner.answers.push({
		kind: "reply",
		text: "yes",
		session: null,
	});
	advisor.onInbox(REPO, [item]);
	await settle();
	advisor.onInbox(REPO, []);
	expect(advisor.list(REPO)).toEqual([]);
	await expect(advisor.accept(REPO, item.id)).rejects.toThrow(
		"no longer pending",
	);
});

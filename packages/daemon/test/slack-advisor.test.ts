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
	ts: "100.0",
	threadTs: "100.0",
	permalink: null,
	at: 100_000,
};

let storage: Storage;
let runner: FakeRunner;
let advisor: SlackAdvisor;
let typed: Array<[string, string]>;
let refreshes: number;
let session: Session;

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
	storage = createMemoryStorage();
	runner = new FakeRunner();
	typed = [];
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
		refreshInbox: () => refreshes++,
		broadcast: () => {},
		log: () => {},
	});
});

test("a new item gets a reply suggestion; y posts exactly that text", async () => {
	runner.answers.push({
		kind: "reply",
		label: 'Reply "yes, in #42"',
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
		label: "Reply",
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

test("an ask types the question; the session's answer becomes a reply", async () => {
	runner.answers.push({
		kind: "ask",
		label: "Ask api-auth if the fix shipped",
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
		label: "Asked api-auth; waiting for its answer",
	});

	runner.answers.push({
		kind: "reply",
		label: 'Reply "shipped in #42"',
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
	expect(advisor.list(REPO)[0]).toMatchObject({
		kind: "reply",
		status: "pending",
		text: "shipped in #42",
	});
});

test("n declines until someone writes in the thread again", async () => {
	runner.answers.push({
		kind: "reply",
		label: "Reply",
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
	runner.answers.push({ kind: "none", label: "", text: null, session: null });
	advisor.onInbox(REPO, [{ ...item, ts: "200.0", text: "any news?" }]);
	await settle();
	expect(runner.calls).toHaveLength(2);
});

test("an item that left the inbox loses its suggestion", async () => {
	runner.answers.push({
		kind: "reply",
		label: "Reply",
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

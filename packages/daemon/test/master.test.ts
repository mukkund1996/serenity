import { beforeEach, describe, expect, test } from "bun:test";
import {
	createMemoryStorage,
	type Session,
	type Storage,
} from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import type { ChatEvent, ClaudeRunner, JsonRunOptions } from "../src/claude";
import { MasterSupervisor } from "../src/master";

/** Answers JSON calls from a queue and records what the chat was sent. */
class FakeRunner implements ClaudeRunner {
	answers: unknown[] = [];
	calls: JsonRunOptions[] = [];
	sent: string[] = [];
	chatStarts = 0;
	emit: (event: ChatEvent) => void = () => {};

	async runJson(opts: JsonRunOptions): Promise<unknown> {
		this.calls.push(opts);
		if (!this.answers.length) throw new Error("no answer queued");
		return this.answers.shift();
	}

	startChat(_opts: unknown, onEvent: (event: ChatEvent) => void) {
		this.chatStarts++;
		this.emit = onEvent;
		return { send: (text: string) => this.sent.push(text), stop: () => {} };
	}
}

const REPO = "/repos/demo";
let storage: Storage;
let runner: FakeRunner;
let master: MasterSupervisor;
let now = 1000;

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function put(overrides: Partial<Session>): Session {
	const s = makeSession({ repo: REPO, ...overrides });
	storage.sessions.put(s);
	return s;
}

/** Applies a change the way the daemon does and lets the master react. */
function change(id: string, patch: Partial<Session>): Session {
	const before = storage.sessions.get(id) as Session;
	const after = { ...before, ...patch, updatedAt: ++now };
	storage.sessions.put(after);
	master.onSessionChanged(before, after);
	return after;
}

beforeEach(() => {
	storage = createMemoryStorage();
	runner = new FakeRunner();
	master = new MasterSupervisor(
		{
			storage,
			now: () => ++now,
			log: () => {},
			broadcast: () => {},
			update: (session, patch) => {
				const next = { ...session, ...patch, updatedAt: ++now };
				storage.sessions.put(next);
				return next;
			},
			mcpConfig: () => "{}",
			workerCwd: "/tmp",
			models: { chat: "opus", summarizer: "haiku", suggester: "sonnet" },
			debounceMs: 0,
		},
		runner,
	);
});

describe("summaries", () => {
	test("a reply triggers a Haiku summary that sets summary, topic and status", async () => {
		put({ id: "a", status: "working", lastPrompt: "rotate tokens" });
		runner.answers.push(
			{
				summary: "Refresh tokens rotate now.",
				ask: null,
				finished: true,
				topic: "Backend",
			},
			{ kind: "cleanup", label: "Clean up the worktree", text: null },
		);
		change("a", { status: "idle", lastAssistantMessage: "Done. Tests pass." });
		await settle();
		expect(runner.calls[0]?.model).toBe("haiku");
		expect(runner.calls[0]?.prompt).toContain("Done. Tests pass.");
		expect(storage.sessions.get("a")).toMatchObject({
			summary: "Refresh tokens rotate now.",
			topic: "backend",
			status: "done",
		});
		// Becoming done needs the user, so Sonnet proposes a cleanup.
		expect(runner.calls[1]?.model).toBe("sonnet");
		expect(storage.suggestions.listPending(REPO)).toMatchObject([
			{ sessionId: "a", kind: "cleanup", source: "worker" },
		]);
	});

	test("a failing worker is recorded as the master's error, then cleared by a success", async () => {
		put({ id: "a", status: "working" });
		change("a", { status: "idle", lastAssistantMessage: "x" });
		await settle();
		expect(master.state(REPO).error).toContain("summary of api-auth failed");
		runner.answers.push({
			summary: "s",
			ask: null,
			finished: false,
			topic: "x",
		});
		change("a", { lastAssistantMessage: "y" });
		await settle();
		expect(master.state(REPO).error).toBeNull();
	});
});

describe("suggestions", () => {
	test("waiting on a permission prompt gets an approve suggestion", async () => {
		put({ id: "a", status: "working" });
		runner.answers.push({
			kind: "approve",
			label: "Approve: terraform plan",
			text: null,
		});
		change("a", {
			status: "waiting",
			waitingOn: "permission",
			ask: "wants to run terraform plan",
		});
		await settle();
		expect(storage.suggestions.listPending(REPO)).toMatchObject([
			{ kind: "approve" },
		]);
	});

	test("a suggestion that no longer fits the session is dropped", async () => {
		put({ id: "a", status: "working" });
		runner.answers.push({ kind: "approve", label: "Approve", text: null });
		change("a", { status: "waiting", waitingOn: "question", ask: "15m?" });
		await settle();
		expect(storage.suggestions.listPending(REPO)).toEqual([]);
	});

	test("work resuming supersedes pending suggestions", async () => {
		put({ id: "a", status: "working" });
		runner.answers.push({ kind: "reply", label: 'Reply "yes"', text: "yes" });
		change("a", { status: "waiting", waitingOn: "question", ask: "15m?" });
		await settle();
		expect(storage.suggestions.listPending(REPO)).toHaveLength(1);
		change("a", { status: "working", waitingOn: null, ask: null });
		expect(storage.suggestions.listPending(REPO)).toEqual([]);
	});
});

describe("chat", () => {
	test("starts on the first message, sends a snapshot, and records the reply", () => {
		put({
			id: "a",
			name: "api-auth",
			status: "waiting",
			waitingOn: "question",
			ask: "15m?",
		});
		master.message(REPO, "what's blocking api-auth?");
		expect(runner.chatStarts).toBe(1);
		expect(runner.sent[0]).toContain(
			"- api-auth [unsorted] waiting on question · asks: 15m?",
		);
		expect(runner.sent[0]).toContain("User: what's blocking api-auth?");
		expect(master.state(REPO).status).toBe("thinking");

		runner.emit({ type: "session", sessionId: "chat-1" });
		runner.emit({ type: "text", text: "It asks about the TTL." });
		runner.emit({
			type: "result",
			isError: false,
			text: "It asks about the TTL.",
		});
		expect(master.state(REPO).status).toBe("idle");
		expect(
			storage.conversation.listRecent(REPO, 5).map((m) => [m.from, m.text]),
		).toEqual([
			["you", "what's blocking api-auth?"],
			["master", "It asks about the TTL."],
		]);

		master.message(REPO, "thanks");
		expect(runner.chatStarts).toBe(1);
	});

	test("the suggest tool creates a pending suggestion, checked against the session", async () => {
		put({
			id: "a",
			name: "api-auth",
			status: "waiting",
			waitingOn: "question",
			ask: "15m?",
		});
		const ok = await master.handleTool(REPO, "suggest", {
			session: "api-auth",
			kind: "reply",
			label: 'Reply "yes, 15m"',
			text: "yes, set it to 15m",
		});
		expect(ok.isError).toBeUndefined();
		expect(storage.suggestions.listPending(REPO)).toMatchObject([
			{ source: "chat", text: "yes, set it to 15m" },
		]);

		const wrong = await master.handleTool(REPO, "suggest", {
			session: "api-auth",
			kind: "approve",
			label: "Approve",
		});
		expect(wrong.isError).toBe(true);
		const missing = await master.handleTool(REPO, "suggest", {
			session: "nope",
			kind: "reply",
			label: "x",
		});
		expect(missing.text).toContain("No session named nope");
	});

	test("set_topic moves a session at once", async () => {
		put({ id: "a", name: "api-auth", topic: "backend" });
		await master.handleTool(REPO, "set_topic", {
			session: "api-auth",
			topic: "Infra",
		});
		expect(storage.sessions.get("a")?.topic).toBe("infra");
	});

	test("a permission request waits for the user's answer", async () => {
		const answer = master.handleTool(REPO, "request_permission", {
			tool_name: "Bash",
			input: { command: "npm test" },
		});
		const [request] = master.permissions(REPO);
		expect(request).toMatchObject({ toolName: "Bash", detail: "npm test" });
		expect(master.answerPermission(request?.id as string, true)).toBe(true);
		expect(JSON.parse((await answer).text)).toEqual({
			behavior: "allow",
			updatedInput: { command: "npm test" },
		});
		expect(master.permissions(REPO)).toEqual([]);
		expect(master.answerPermission(request?.id as string, true)).toBe(false);
	});

	test("a denied permission tells claude so", async () => {
		const answer = master.handleTool(REPO, "request_permission", {
			tool_name: "Edit",
			input: { file_path: "/x" },
		});
		master.answerPermission(master.permissions(REPO)[0]?.id as string, false);
		expect(JSON.parse((await answer).text).behavior).toBe("deny");
	});
});

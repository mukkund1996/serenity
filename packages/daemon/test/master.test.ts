import { beforeEach, describe, expect, test } from "bun:test";
import {
	type CreateSessionParams,
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

let killed: string[];
let opened: string[];
let created: CreateSessionParams[];

beforeEach(() => {
	killed = [];
	opened = [];
	created = [];
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
			kill: async (session) => {
				killed.push(session.name);
				storage.sessions.put({ ...session, status: "archived" });
			},
			open: async (session) => {
				opened.push(session.name);
			},
			create: async (params) => {
				created.push(params);
				return put({
					id: `new-${params.name}`,
					name: params.name,
					branch: params.name,
				});
			},
			pluginDir: "/tmp/master-plugin",
			mcpConfig: () => "{}",
			slack: () => null,
			workerCwd: "/tmp",
			models: { chat: "opus", summarizer: "haiku", suggester: "sonnet" },
			maxTopics: 3,
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

	test("a pinned session's finished task leaves it idle, in its topic, with no cleanup", async () => {
		put({ id: "a", status: "working", topic: "auth", pinned: true });
		runner.answers.push({
			summary: "Refresh tokens rotate now.",
			ask: null,
			finished: true,
			topic: "backend",
		});
		change("a", { status: "idle", lastAssistantMessage: "Done. Tests pass." });
		await settle();
		expect(storage.sessions.get("a")).toMatchObject({
			summary: "Refresh tokens rotate now.",
			topic: "auth",
			status: "idle",
		});
		expect(runner.calls).toHaveLength(1);
		expect(storage.suggestions.listPending(REPO)).toEqual([]);
	});

	test("pinned sessions' topics do not count toward the cap", async () => {
		put({ id: "t1", name: "one", topic: "backend" });
		put({ id: "t2", name: "two", topic: "infra", pinned: true });
		put({ id: "a", status: "working" });
		runner.answers.push({
			summary: "s",
			ask: null,
			finished: false,
			topic: "web",
		});
		change("a", { status: "idle", lastAssistantMessage: "x" });
		await settle();
		expect(runner.calls[0]?.prompt).toContain("Existing topics: backend\n");
	});

	test("at the topic cap the summarizer must reuse a topic, and a new one is dropped", async () => {
		put({ id: "t1", name: "one", topic: "backend" });
		put({ id: "t2", name: "two", topic: "infra" });
		put({ id: "t3", name: "three", topic: "docs" });
		put({ id: "a", status: "working" });
		runner.answers.push({
			summary: "s",
			ask: null,
			finished: false,
			topic: "frontend",
		});
		change("a", { status: "idle", lastAssistantMessage: "x" });
		await settle();
		expect(runner.calls[0]?.prompt).toContain("one of the existing topics");
		expect(JSON.stringify(runner.calls[0]?.schema)).toContain(
			'"enum":["backend","infra","docs"]',
		);
		expect(storage.sessions.get("a")?.topic).toBeNull();
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

	test("set_topic leaves pinning to the user", async () => {
		put({ id: "a", name: "api-auth", topic: "backend" });
		put({ id: "b", name: "kept", topic: "backend", pinned: true });
		const toPinned = await master.handleTool(REPO, "set_topic", {
			session: "api-auth",
			topic: "pinned",
		});
		expect(toPinned.isError).toBe(true);
		const fromPinned = await master.handleTool(REPO, "set_topic", {
			session: "kept",
			topic: "infra",
		});
		expect(fromPinned.isError).toBe(true);
		expect(storage.sessions.get("a")?.topic).toBe("backend");
		expect(storage.sessions.get("b")?.topic).toBe("backend");
	});

	test("the chat cannot suggest cleaning up a pinned session", async () => {
		put({ id: "a", name: "kept", status: "idle", pinned: true });
		const result = await master.handleTool(REPO, "suggest", {
			session: "kept",
			kind: "cleanup",
			label: "Clean up",
		});
		expect(result.isError).toBe(true);
		expect(result.text).toContain("pinned");
	});

	test("set_topic refuses a new topic past the cap", async () => {
		put({ id: "a", name: "api-auth", topic: "backend" });
		put({ id: "b", name: "infra-1", topic: "infra" });
		put({ id: "c", name: "docs-1", topic: "docs" });
		put({ id: "d", name: "web-1", topic: "web" });
		const refused = await master.handleTool(REPO, "set_topic", {
			session: "api-auth",
			topic: "frontend",
		});
		expect(refused.isError).toBe(true);
		expect(refused.text).toContain("infra, docs, web");
		// Moving into an existing topic is always fine.
		await master.handleTool(REPO, "set_topic", {
			session: "api-auth",
			topic: "web",
		});
		expect(storage.sessions.get("a")?.topic).toBe("web");
	});

	test("archive_session kills the session once; archived stays archived", async () => {
		put({ id: "a", name: "api-auth", status: "working" });
		const first = await master.handleTool(REPO, "archive_session", {
			session: "api-auth",
		});
		expect(first.text).toBe("Stopped and archived api-auth.");
		const again = await master.handleTool(REPO, "archive_session", {
			session: "api-auth",
		});
		expect(again.text).toContain("already archived");
		expect(killed).toEqual(["api-auth"]);
		expect(storage.sessions.get("a")?.status).toBe("archived");
	});

	test("open_session attaches the session beside the map", async () => {
		put({ id: "a", name: "api-auth" });
		const result = await master.handleTool(REPO, "open_session", {
			session: "api-auth",
		});
		expect(result.text).toBe("Opened api-auth beside the map.");
		expect(opened).toEqual(["api-auth"]);
	});

	test("create_session starts a worktree session with the brief's prompt", async () => {
		const result = await master.handleTool(REPO, "create_session", {
			name: "api-auth",
			prompt: "  Rotate refresh tokens.  ",
		});
		expect(result.isError).toBeFalsy();
		expect(result.text).toContain("Started api-auth on branch api-auth");
		expect(created).toEqual([
			{
				repo: REPO,
				name: "api-auth",
				cwd: REPO,
				mode: "worktree",
				prompt: "Rotate refresh tokens.",
			},
		]);
	});

	test("create_session puts the session under the given topic", async () => {
		await master.handleTool(REPO, "create_session", {
			name: "api-auth",
			prompt: "Rotate refresh tokens.",
			topic: "Auth",
		});
		expect(storage.sessions.get("new-api-auth")?.topic).toBe("auth");
	});

	test("create_session needs a name and a prompt, and keeps to the topic cap", async () => {
		const noPrompt = await master.handleTool(REPO, "create_session", {
			name: "api-auth",
		});
		expect(noPrompt).toMatchObject({ isError: true });
		put({ id: "a", topic: "one" });
		put({ id: "b", topic: "two" });
		put({ id: "c", topic: "three" });
		const pastCap = await master.handleTool(REPO, "create_session", {
			name: "api-auth",
			prompt: "Rotate refresh tokens.",
			topic: "four",
		});
		expect(pastCap.isError).toBe(true);
		expect(pastCap.text).toContain("Pick one of: one, two, three");
		expect(created).toEqual([]);
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

	test("a Slack message the user confirmed in the chat is sent without asking", async () => {
		storage.conversation.append({
			repo: REPO,
			from: "master",
			text: "To #eng:\n\n> merged in #42\n\nSend it?",
			at: 1,
		});
		storage.conversation.append({
			repo: REPO,
			from: "you",
			text: "yes",
			at: 2,
		});
		const input = { channel_id: "C1", message: "merged in #42" };
		const answer = await master.handleTool(REPO, "request_permission", {
			tool_name: "mcp__slack__slack_send_message",
			input,
		});
		expect(JSON.parse(answer.text)).toEqual({
			behavior: "allow",
			updatedInput: input,
		});
		expect(master.permissions(REPO)).toEqual([]);
	});

	test("a Slack message with other text waits for y", async () => {
		storage.conversation.append({
			repo: REPO,
			from: "master",
			text: "> merged in #42",
			at: 1,
		});
		storage.conversation.append({
			repo: REPO,
			from: "you",
			text: "yes",
			at: 2,
		});
		const answer = master.handleTool(REPO, "request_permission", {
			tool_name: "mcp__slack__slack_send_message",
			input: { channel_id: "C1", message: "merged in #43" },
		});
		const [request] = master.permissions(REPO);
		expect(request?.toolName).toBe("mcp__slack__slack_send_message");
		master.answerPermission(request?.id as string, false);
		expect(JSON.parse((await answer).text).behavior).toBe("deny");
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

describe("status and watches", () => {
	const slackSend = (message: string) =>
		master.handleTool(REPO, "request_permission", {
			tool_name: "mcp__slack__slack_send_message",
			input: { channel_id: "C1", message },
		});

	function confirmDraft(text: string): void {
		storage.conversation.append({
			repo: REPO,
			from: "master",
			text: `To #eng:\n\n> ${text}\n\nSend it when api finishes?`,
			at: 1,
		});
		storage.conversation.append({
			repo: REPO,
			from: "you",
			text: "yes",
			at: 2,
		});
	}

	test("session_status reads the session as it is now, or every session", async () => {
		const s = put({ name: "api", status: "working", lastPrompt: "add auth" });
		change(s.id, { status: "idle", lastAssistantMessage: "Auth added." });
		const one = await master.handleTool(REPO, "session_status", {
			session: "api",
		});
		expect(one.text).toContain("api [");
		expect(one.text).toContain("idle");
		expect(one.text).toContain("last reply: Auth added.");
		const all = await master.handleTool(REPO, "session_status", {});
		expect(all.text).toContain("Sessions now:");
	});

	test("a watch tells the chat when the turn ends, once, and not as the user", async () => {
		const s = put({ name: "api", status: "working" });
		const out = await master.handleTool(REPO, "watch_session", {
			session: "api",
			note: "tell the user",
		});
		expect(out.isError).toBeFalsy();
		change(s.id, { status: "working", lastPrompt: "more" });
		expect(runner.sent).toEqual([]);
		change(s.id, { status: "idle", lastAssistantMessage: "Done." });
		expect(runner.sent).toHaveLength(1);
		expect(runner.sent[0]).toContain("serenity: api is now idle");
		expect(runner.sent[0]).toContain("Its last reply: Done.");
		expect(storage.conversation.listRecent(REPO, 5)).toEqual([]);
		change(s.id, { status: "working" });
		change(s.id, { status: "idle" });
		expect(runner.sent).toHaveLength(1);
	});

	test("waiting on the user tells the chat but stays watched", async () => {
		const s = put({ name: "api", status: "working" });
		await master.handleTool(REPO, "watch_session", {
			session: "api",
			note: "tell the user",
		});
		change(s.id, {
			status: "waiting",
			waitingOn: "permission",
			ask: "wants to run make",
		});
		expect(runner.sent[0]).toContain("It asks: wants to run make");
		runner.emit({ type: "result", text: "", isError: false });
		change(s.id, { status: "working", waitingOn: null, ask: null });
		change(s.id, { status: "idle" });
		expect(runner.sent).toHaveLength(2);
		expect(runner.sent[1]).toContain("The watch is over.");
	});

	test("a watch that fires while the chat is busy waits for its turn to end", async () => {
		const s = put({ name: "api", status: "working" });
		await master.handleTool(REPO, "watch_session", {
			session: "api",
			note: "tell the user",
		});
		master.message(REPO, "what's up?");
		change(s.id, { status: "idle" });
		expect(runner.sent).toHaveLength(1);
		runner.emit({ type: "result", text: "busy", isError: false });
		expect(runner.sent).toHaveLength(2);
		expect(runner.sent[1]).toContain("serenity: api is now idle");
	});

	test("a confirmed Slack message is held until the session finishes, then sent once", async () => {
		const s = put({ name: "api", status: "working" });
		confirmDraft("api is done");
		const out = await master.handleTool(REPO, "watch_session", {
			session: "api",
			note: "send the confirmed message to #eng",
			slack_text: "api is done",
		});
		expect(out.isError).toBeFalsy();
		storage.conversation.append({
			repo: REPO,
			from: "master",
			text: "I'll send it when api finishes.",
			at: 3,
		});
		// Not finished yet: the send asks the user.
		const early = slackSend("api is done");
		expect(master.permissions(REPO)).toHaveLength(1);
		master.answerPermission(master.permissions(REPO)[0]?.id as string, false);
		expect(JSON.parse((await early).text).behavior).toBe("deny");

		change(s.id, { status: "idle", lastAssistantMessage: "Done." });
		expect(runner.sent[0]).toContain("may go out now");
		expect(JSON.parse((await slackSend("api is done")).text).behavior).toBe(
			"allow",
		);
		// Once only.
		const again = slackSend("api is done");
		expect(master.permissions(REPO)).toHaveLength(1);
		master.answerPermission(master.permissions(REPO)[0]?.id as string, false);
		expect(JSON.parse((await again).text).behavior).toBe("deny");
	});

	test("a Slack message the user did not just confirm cannot be staged", async () => {
		put({ name: "api", status: "working" });
		confirmDraft("api is done");
		const out = await master.handleTool(REPO, "watch_session", {
			session: "api",
			note: "send it",
			slack_text: "api is done, deploying now",
		});
		expect(out.isError).toBe(true);
	});

	test("an ended session cannot be watched, and a watch can be cancelled", async () => {
		const s = put({ name: "api", status: "working" });
		put({ id: "s2", name: "old", status: "dead" });
		expect(
			(
				await master.handleTool(REPO, "watch_session", {
					session: "old",
					note: "x",
				})
			).isError,
		).toBe(true);
		await master.handleTool(REPO, "watch_session", {
			session: "api",
			note: "x",
		});
		await master.handleTool(REPO, "watch_session", {
			session: "api",
			cancel: true,
		});
		change(s.id, { status: "idle" });
		expect(runner.sent).toEqual([]);
	});
});

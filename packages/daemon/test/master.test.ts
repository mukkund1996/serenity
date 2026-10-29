import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
	type CreateSessionParams,
	createMemoryStorage,
	type Session,
	type Storage,
} from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import type {
	ChatEvent,
	ChatOptions,
	ClaudeRunner,
	JsonRunOptions,
} from "../src/claude";
import {
	CHAT_HANG_MS,
	CHAT_RESTART_BACKOFF_MS,
	type MasterHost,
	MasterSupervisor,
	TOOL_TIMEOUT_MS,
} from "../src/master";

/** Answers JSON calls from a queue and records what the chat was sent. */
class FakeRunner implements ClaudeRunner {
	answers: unknown[] = [];
	calls: JsonRunOptions[] = [];
	sent: string[] = [];
	chatStarts = 0;
	/** --resume of each chat started. */
	resumes: Array<string | null> = [];
	stops = 0;
	/** Makes the chat's stdin throw, as a process that died does. */
	brokenPipe = false;
	emit: (event: ChatEvent) => void = () => {};

	async runJson(opts: JsonRunOptions): Promise<unknown> {
		this.calls.push(opts);
		if (!this.answers.length) throw new Error("no answer queued");
		return this.answers.shift();
	}

	startChat(opts: ChatOptions, onEvent: (event: ChatEvent) => void) {
		this.chatStarts++;
		this.resumes.push(opts.resume);
		this.emit = onEvent;
		return {
			send: (text: string) => {
				if (this.brokenPipe) throw new Error("EPIPE");
				this.sent.push(text);
			},
			stop: () => {
				this.stops++;
			},
		};
	}
}

const REPO = "/repos/demo";
let storage: Storage;
let runner: FakeRunner;
let host: MasterHost;
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
let replies: Array<{ name: string; text: string }>;

beforeEach(() => {
	replies = [];
	killed = [];
	opened = [];
	created = [];
	storage = createMemoryStorage();
	runner = new FakeRunner();
	host = {
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
		reply: async (session, text) => {
			if (session.tmuxPane === "%gone")
				throw new Error(`${session.name} has ended`);
			replies.push({ name: session.name, text });
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
	};
	master = new MasterSupervisor(host, runner);
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

	describe("topic moves wait (ADR 0047)", () => {
		const summary = (topic: string) => ({
			summary: "s",
			ask: null,
			finished: false,
			topic,
		});

		test("a move settled while the session works waits until it stops", async () => {
			put({ id: "t", name: "other", topic: "infra" });
			put({ id: "a", topic: "backend", topicCandidate: "infra" });
			runner.answers.push(summary("infra"));
			change("a", { status: "working", lastAssistantMessage: "progress" });
			await settle();
			expect(storage.sessions.get("a")).toMatchObject({
				topic: "backend",
				topicHeld: "infra",
			});
			change("a", { status: "idle" });
			await settle();
			expect(storage.sessions.get("a")).toMatchObject({
				topic: "infra",
				topicHeld: null,
			});
		});

		test("a move waits while the user types, and goes through when they stop", async () => {
			put({ id: "a", topic: "backend", topicCandidate: "infra" });
			master.setTyping(REPO, true);
			runner.answers.push(summary("infra"));
			change("a", { status: "idle", lastAssistantMessage: "x" });
			await settle();
			expect(storage.sessions.get("a")).toMatchObject({
				topic: "backend",
				topicHeld: "infra",
			});
			// Stopping work is not enough while the user still types.
			change("a", { status: "waiting" });
			await settle();
			expect(storage.sessions.get("a")?.topic).toBe("backend");
			master.setTyping(REPO, false);
			expect(storage.sessions.get("a")).toMatchObject({
				topic: "infra",
				topicHeld: null,
			});
		});

		test("typing stops while it still works: the move waits for the work", async () => {
			put({ id: "a", status: "working", topic: "backend", topicHeld: "infra" });
			master.setTyping(REPO, true);
			master.setTyping(REPO, false);
			expect(storage.sessions.get("a")?.topic).toBe("backend");
			change("a", { status: "done" });
			await settle();
			expect(storage.sessions.get("a")?.topic).toBe("infra");
		});

		test("a held new topic is dropped if the cap filled up meanwhile", async () => {
			put({ id: "t1", name: "one", topic: "backend" });
			put({ id: "t2", name: "two", topic: "infra" });
			put({ id: "t3", name: "three", topic: "docs" });
			put({ id: "a", status: "working", topic: "backend", topicHeld: "web" });
			change("a", { status: "idle" });
			await settle();
			expect(storage.sessions.get("a")).toMatchObject({
				topic: "backend",
				topicHeld: null,
			});
		});

		test("set_topic and create_session move at once, while working or typing", async () => {
			put({
				id: "a",
				name: "api-auth",
				status: "working",
				topic: "backend",
				topicHeld: "infra",
			});
			master.setTyping(REPO, true);
			await master.handleTool(REPO, "set_topic", {
				session: "api-auth",
				topic: "docs",
			});
			expect(storage.sessions.get("a")).toMatchObject({
				topic: "docs",
				topicHeld: null,
			});
			await master.handleTool(REPO, "create_session", {
				name: "fresh",
				prompt: "go",
				topic: "docs",
			});
			expect(storage.sessions.get("new-fresh")?.topic).toBe("docs");
		});
	});

	test("a near-duplicate topic name joins the existing topic", async () => {
		put({ id: "t", name: "other", topic: "master agent" });
		put({ id: "a", name: "api-auth", topic: "backend" });
		const result = await master.handleTool(REPO, "set_topic", {
			session: "api-auth",
			topic: "Master Agents",
		});
		expect(result.text).toBe("Moved api-auth to master agent.");
		expect(storage.sessions.get("a")?.topic).toBe("master agent");
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

	describe("a name shared by an archived and a live session", () => {
		// "api-auth" was archived, then a new session took the name. The archived
		// one is listed first, and the newer by every measure but status.
		beforeEach(() => {
			put({ id: "old", name: "api-auth", status: "archived", createdAt: 1 });
			put({ id: "live", name: "api-auth", status: "idle", createdAt: 2 });
		});

		test("send_reply reaches the live one", async () => {
			storage.conversation.append({
				repo: REPO,
				from: "you",
				text: "tell api-auth 'yes'",
				at: ++now,
			});
			const result = await master.handleTool(REPO, "send_reply", {
				session: "api-auth",
				text: "yes",
			});
			expect(result.isError).toBeUndefined();
			expect(replies).toEqual([{ name: "api-auth", text: "yes" }]);
		});

		test("suggest is shown for the live one", async () => {
			storage.sessions.put({
				...(storage.sessions.get("live") as Session),
				status: "waiting",
				waitingOn: "question",
				ask: "15m?",
			});
			const result = await master.handleTool(REPO, "suggest", {
				session: "api-auth",
				kind: "reply",
				label: 'Reply "yes"',
				text: "yes",
			});
			expect(result.isError).toBeUndefined();
			expect(storage.suggestions.listPending(REPO)).toMatchObject([
				{ sessionId: "live", text: "yes" },
			]);
		});

		test("session_status and watch_session read the live one", async () => {
			const status = await master.handleTool(REPO, "session_status", {
				session: "api-auth",
			});
			expect(status.text).toContain("idle");
			expect(status.text).not.toContain("archived");
			storage.sessions.put({
				...(storage.sessions.get("live") as Session),
				status: "working",
			});
			const watch = await master.handleTool(REPO, "watch_session", {
				session: "api-auth",
				note: "tell the user",
			});
			expect(watch.isError).toBeUndefined();
			expect(watch.text).toContain("Watching api-auth");
			// Fires for the live session's turn ending, not the archived one's.
			change("live", { status: "idle" });
			await settle();
			expect(runner.sent.join("\n")).toContain("api-auth");
		});

		test("open_session, set_topic and archive_session act on the live one", async () => {
			await master.handleTool(REPO, "open_session", { session: "api-auth" });
			expect(opened).toEqual(["api-auth"]);
			await master.handleTool(REPO, "set_topic", {
				session: "api-auth",
				topic: "auth",
			});
			expect(storage.sessions.get("live")?.topic).toBe("auth");
			expect(storage.sessions.get("old")?.topic).toBeNull();
			const archive = await master.handleTool(REPO, "archive_session", {
				session: "api-auth",
			});
			expect(archive.text).toBe("Stopped and archived api-auth.");
			expect(killed).toEqual(["api-auth"]);
		});

		test("once the live one goes, the archived one is still found", async () => {
			storage.sessions.put({
				...(storage.sessions.get("live") as Session),
				status: "archived",
			});
			const status = await master.handleTool(REPO, "session_status", {
				session: "api-auth",
			});
			expect(status.isError).toBeUndefined();
			expect(status.text).toContain("archived");
		});
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

	describe("send_reply", () => {
		const say = (from: "you" | "master", text: string) =>
			storage.conversation.append({ repo: REPO, from, text, at: ++now });

		test("sends at once the text the user's message asked for", async () => {
			put({ id: "a", name: "api-auth", status: "waiting", ask: "15m?" });
			say("you", "tell api-auth 'yes, set it to 15m'");
			const result = await master.handleTool(REPO, "send_reply", {
				session: "api-auth",
				text: "yes, set it to 15m",
			});
			expect(result).toEqual({ text: "Sent to api-auth." });
			expect(replies).toEqual([
				{ name: "api-auth", text: "yes, set it to 15m" },
			]);
		});

		test("sends text the master showed once the user confirms, replacing its queued reply", async () => {
			put({ id: "a", name: "dismiss-slack-item", status: "idle" });
			const text = "Ask me questions before you change anything.";
			say("you", "tell dismiss-slack-item to ask questions");
			const queued = await master.handleTool(REPO, "send_reply", {
				session: "dismiss-slack-item",
				text,
			});
			expect(queued.isError).toBeUndefined();
			expect(queued.text).toContain("waits in the master's queue");
			expect(replies).toEqual([]);
			expect(storage.suggestions.listPending(REPO)).toMatchObject([
				{ kind: "reply", source: "chat", text },
			]);

			say("master", `Queued for your y:\n\n> ${text}`);
			say("you", "just send it");
			const sent = await master.handleTool(REPO, "send_reply", {
				session: "dismiss-slack-item",
				text,
			});
			expect(sent.text).toBe("Sent to dismiss-slack-item.");
			expect(replies).toEqual([{ name: "dismiss-slack-item", text }]);
			expect(storage.suggestions.listPending(REPO)).toEqual([]);
		});

		test("text the user did not ask for falls back to the queue", async () => {
			put({ id: "a", name: "api-auth", status: "waiting" });
			say("master", "> yes, set it to 15m\n\nSend it?");
			say("you", "yes");
			const result = await master.handleTool(REPO, "send_reply", {
				session: "api-auth",
				text: "yes, set it to 30m",
			});
			expect(result.isError).toBeUndefined();
			expect(result.text).toContain("runs only if they press y");
			expect(replies).toEqual([]);
			expect(storage.suggestions.listPending(REPO)).toMatchObject([
				{ label: 'Reply "yes, set it to 30m"', text: "yes, set it to 30m" },
			]);
		});

		describe("pings for the map (ADR 0039)", () => {
			const send = async () => {
				say("you", "@api-auth add tests");
				return master.handleTool(REPO, "send_reply", {
					session: "api-auth",
					text: "Add tests for the refresh.",
				});
			};
			const pinged = () => master.pings(REPO).map((p) => p.to);

			afterEach(() => jest.useRealTimers());

			test("a send pings the session, and its next turn end the master", async () => {
				put({ id: "a", name: "api-auth", status: "idle" });
				await send();
				expect(master.pings(REPO)).toMatchObject([
					{ sessionId: "a", to: "session" },
				]);
				change("a", { status: "working" });
				expect(pinged()).toEqual(["session"]);
				change("a", { status: "idle" });
				expect(master.pings(REPO)).toMatchObject([
					{ sessionId: "a", to: "session" },
					{ sessionId: "a", to: "master" },
				]);
				// Answered once: later turns are the session's own.
				change("a", { status: "working" });
				change("a", { status: "idle" });
				expect(pinged()).toEqual(["session", "master"]);
			});

			test("a send it never answers, or one the user did not ask for, pings nothing back", async () => {
				put({ id: "a", name: "api-auth", status: "idle" });
				put({ id: "b", name: "web", status: "idle" });
				say("you", "tell web something");
				await master.handleTool(REPO, "send_reply", {
					session: "web",
					text: "Rebase on main.",
				});
				expect(master.pings(REPO)).toEqual([]);
				await send();
				change("a", { status: "dead" });
				expect(pinged()).toEqual(["session"]);
			});

			test("a send to a working session: the turn after it answers when the message was queued", async () => {
				jest.useFakeTimers();
				put({ id: "a", name: "api-auth", status: "working" });
				await send();
				change("a", { status: "idle" });
				change("a", { status: "working", lastPrompt: "Add tests" });
				jest.advanceTimersByTime(5_000);
				expect(pinged()).toEqual(["session"]);
				change("a", { status: "idle" });
				expect(pinged()).toEqual(["session", "master"]);
			});

			test("a send to a working session: that turn answers when Claude read it there", async () => {
				jest.useFakeTimers();
				put({ id: "a", name: "api-auth", status: "working" });
				await send();
				change("a", { status: "waiting", waitingOn: "question" });
				expect(pinged()).toEqual(["session"]);
				jest.advanceTimersByTime(2_000);
				expect(pinged()).toEqual(["session", "master"]);
			});

			test("pings fade after a few seconds", async () => {
				put({ id: "a", name: "api-auth", status: "idle" });
				await send();
				expect(pinged()).toEqual(["session"]);
				now += 6_000;
				expect(master.pings(REPO)).toEqual([]);
			});
		});

		describe("an @mention of the session (ADR 0036)", () => {
			const text = "Ask me questions before you change anything.";

			test("sends whatever text the master writes, at once", async () => {
				put({ id: "a", name: "api-auth", status: "idle" });
				say("you", "@api-auth ask me questions before changing things");
				const result = await master.handleTool(REPO, "send_reply", {
					session: "api-auth",
					text,
				});
				expect(result).toEqual({ text: "Sent to api-auth." });
				expect(replies).toEqual([{ name: "api-auth", text }]);
				expect(storage.suggestions.listPending(REPO)).toEqual([]);
			});

			test("without the mention the same text waits in the queue", async () => {
				put({ id: "a", name: "api-auth", status: "idle" });
				say("you", "ask api-auth to ask me questions before changing things");
				const result = await master.handleTool(REPO, "send_reply", {
					session: "api-auth",
					text,
				});
				expect(result.text).toContain("waits in the master's queue");
				expect(replies).toEqual([]);
				expect(storage.suggestions.listPending(REPO)).toHaveLength(1);
			});

			test("mentioning another session, or a prefix of the name, sends nothing", async () => {
				put({ id: "a", name: "api-auth", status: "idle" });
				put({ id: "b", name: "web-login", status: "idle" });
				for (const said of ["@web-login how is it going", "@api tell it"]) {
					say("you", said);
					await master.handleTool(REPO, "send_reply", {
						session: "api-auth",
						text,
					});
				}
				expect(replies).toEqual([]);
			});

			test("only the user's latest message counts", async () => {
				put({ id: "a", name: "api-auth", status: "idle" });
				say("you", "@api-auth look at this");
				say("master", "Looking.");
				await master.handleTool(REPO, "send_reply", {
					session: "api-auth",
					text,
				});
				expect(replies).toEqual([]);
				say("you", "ok");
				await master.handleTool(REPO, "send_reply", {
					session: "api-auth",
					text,
				});
				expect(replies).toEqual([]);
			});

			test("resolves a name shared with an archived session to the live one", async () => {
				put({ id: "old", name: "api-auth", status: "archived", createdAt: 1 });
				put({ id: "live", name: "api-auth", status: "working", createdAt: 2 });
				say("you", "@api-auth add tests");
				const result = await master.handleTool(REPO, "send_reply", {
					session: "api-auth",
					text: "Add tests for the token refresh.",
				});
				expect(result.isError).toBeUndefined();
				expect(replies).toEqual([
					{ name: "api-auth", text: "Add tests for the token refresh." },
				]);
			});

			test("does not reach an archived or ended session, or one on a permission prompt", async () => {
				put({ id: "r", name: "old-one", status: "archived" });
				put({ id: "d", name: "dead-one", status: "dead" });
				put({
					id: "p",
					name: "asking",
					status: "waiting",
					waitingOn: "permission",
				});
				for (const session of ["old-one", "dead-one", "asking"]) {
					say("you", `@${session} do it`);
					const result = await master.handleTool(REPO, "send_reply", {
						session,
						text,
					});
					expect(result.isError).toBe(true);
				}
				expect(replies).toEqual([]);
			});
		});

		test("a serenity message never confirms: the user's message must be the latest", async () => {
			put({ id: "a", name: "api-auth", status: "idle" });
			say("you", "tell api-auth yes");
			say("master", "Sent.");
			await master.handleTool(REPO, "send_reply", {
				session: "api-auth",
				text: "yes",
			});
			expect(replies).toEqual([]);
			expect(storage.suggestions.listPending(REPO)).toHaveLength(1);
		});

		test("a working session gets it, read when its turn ends", async () => {
			put({ id: "a", name: "api-auth", status: "working" });
			say("you", "tell api-auth add tests too");
			const result = await master.handleTool(REPO, "send_reply", {
				session: "api-auth",
				text: "add tests too",
			});
			expect(result.text).toContain("reads it when this turn ends");
			expect(replies).toHaveLength(1);
		});

		test("refuses ended, archived and permission-prompt sessions, and a gone pane", async () => {
			put({ id: "d", name: "dead-one", status: "dead" });
			put({ id: "r", name: "old-one", status: "archived" });
			put({
				id: "p",
				name: "asking",
				status: "waiting",
				waitingOn: "permission",
			});
			put({ id: "g", name: "gone", status: "idle", tmuxPane: "%gone" });
			for (const session of ["dead-one", "old-one", "asking", "gone"]) {
				say("you", `tell ${session} yes`);
				const result = await master.handleTool(REPO, "send_reply", {
					session,
					text: "yes",
				});
				expect(result.isError).toBe(true);
			}
			expect(replies).toEqual([]);
			expect(storage.suggestions.listPending(REPO)).toEqual([]);
			const asking = await master.handleTool(REPO, "send_reply", {
				session: "asking",
				text: "yes",
			});
			expect(asking.text).toContain("permission prompt");
			const empty = await master.handleTool(REPO, "send_reply", {
				session: "gone",
				text: " ",
			});
			expect(empty.text).toContain("needs the text");
		});
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

describe("robustness (ADR 0046)", () => {
	afterEach(() => jest.useRealTimers());

	const result = (text = "ok") =>
		runner.emit({ type: "result", isError: false, text });
	const exit = (code = 1) =>
		runner.emit({ type: "exit", code, stderr: "boom" });
	/** A supervisor on the same storage, as after a daemon restart. */
	const restartDaemon = () => {
		master.stop();
		master = new MasterSupervisor(host, runner);
	};

	test("a message sent while the chat thinks waits for its turn to end", () => {
		master.message(REPO, "first");
		master.message(REPO, "second");
		expect(runner.sent).toHaveLength(1);
		result("one");
		expect(runner.sent).toHaveLength(2);
		expect(runner.sent[1]).toContain("User: second");
		result("two");
		expect(master.state(REPO).status).toBe("idle");
		expect(storage.conversation.listRecent(REPO, 5).map((m) => m.text)).toEqual(
			["first", "second", "one", "two"],
		);
	});

	test("a chat that dies mid-turn is resumed and sent the message again", () => {
		jest.useFakeTimers();
		master.message(REPO, "hello");
		runner.emit({ type: "session", sessionId: "chat-1" });
		exit();
		expect(master.state(REPO)).toEqual({
			status: "thinking",
			error: "master stopped (exit 1) boom; restarting (1/3)",
		});
		expect(runner.chatStarts).toBe(1);
		jest.advanceTimersByTime(CHAT_RESTART_BACKOFF_MS[0] as number);
		expect(runner.chatStarts).toBe(2);
		expect(runner.resumes).toEqual([null, "chat-1"]);
		expect(runner.sent[1]).toContain("your process restarted");
		expect(runner.sent[1]).toContain("User: hello");
		result("hi");
		expect(master.state(REPO)).toEqual({ status: "idle", error: null });
		// The next message has no restart note.
		master.message(REPO, "again");
		expect(runner.sent[2]).not.toContain("your process restarted");
	});

	test("after the last restart fails it gives up on that message; the next one goes out", () => {
		jest.useFakeTimers();
		master.message(REPO, "doomed");
		for (const wait of CHAT_RESTART_BACKOFF_MS) {
			exit();
			jest.advanceTimersByTime(wait);
		}
		expect(runner.chatStarts).toBe(4);
		exit();
		expect(master.state(REPO)).toEqual({
			status: "idle",
			error:
				"master stopped (exit 1) boom; gave up after 3 restarts, your message was not answered",
		});
		jest.advanceTimersByTime(60_000);
		expect(runner.chatStarts).toBe(4);
		master.message(REPO, "fresh");
		expect(runner.chatStarts).toBe(5);
		expect(runner.sent.at(-1)).toContain("User: fresh");
		expect(runner.sent.at(-1)).not.toContain("your process restarted");
	});

	test("a chat that cannot resume its session starts fresh next time", () => {
		jest.useFakeTimers();
		storage.master.put({
			repo: REPO,
			claudeSessionId: "gone",
			watches: [],
			released: [],
			outbox: [],
		});
		restartDaemon();
		master.message(REPO, "hello");
		exit();
		jest.advanceTimersByTime(CHAT_RESTART_BACKOFF_MS[0] as number);
		expect(runner.resumes).toEqual(["gone", null]);
		expect(storage.master.get(REPO)?.claudeSessionId).toBeNull();
	});

	test("a turn with no output for the hang limit is killed and restarted", () => {
		jest.useFakeTimers();
		master.message(REPO, "hello");
		jest.advanceTimersByTime(CHAT_HANG_MS - 1_000);
		runner.emit({ type: "activity" });
		jest.advanceTimersByTime(CHAT_HANG_MS - 1_000);
		expect(runner.stops).toBe(0);
		jest.advanceTimersByTime(1_000);
		expect(runner.stops).toBe(1);
		expect(master.state(REPO).error).toBe(
			"master hung (no output for 5m); restarting (1/3)",
		);
		// The killed process's exit is not counted again.
		exit();
		jest.advanceTimersByTime(CHAT_RESTART_BACKOFF_MS[0] as number);
		expect(runner.chatStarts).toBe(2);
		expect(runner.sent[1]).toContain("User: hello");
	});

	test("a turn waiting on the user's permission answer is not hung", async () => {
		jest.useFakeTimers();
		master.message(REPO, "post it");
		const asked = master.handleTool(REPO, "request_permission", {
			tool_name: "Bash",
			input: { command: "make" },
		});
		jest.advanceTimersByTime(CHAT_HANG_MS * 1.5);
		expect(runner.stops).toBe(0);
		master.answerPermission(master.permissions(REPO)[0]?.id as string, true);
		await asked;
		jest.advanceTimersByTime(CHAT_HANG_MS);
		expect(runner.stops).toBe(1);
	});

	test("a chat whose stdin is gone counts as a crash, not a lost message", () => {
		jest.useFakeTimers();
		runner.brokenPipe = true;
		master.message(REPO, "hello");
		expect(master.state(REPO).error).toBe(
			"master stopped (EPIPE); restarting (1/3)",
		);
		runner.brokenPipe = false;
		jest.advanceTimersByTime(CHAT_RESTART_BACKOFF_MS[0] as number);
		expect(runner.sent).toHaveLength(1);
		expect(runner.sent[0]).toContain("User: hello");
	});

	test("a chat that exits denies its pending permission requests", async () => {
		master.message(REPO, "post it");
		const asked = master.handleTool(REPO, "request_permission", {
			tool_name: "Bash",
			input: { command: "make" },
		});
		expect(master.permissions(REPO)).toHaveLength(1);
		exit();
		expect(master.permissions(REPO)).toEqual([]);
		expect(JSON.parse((await asked).text).behavior).toBe("deny");
	});

	test("watches, released Slack messages and the chat session outlive the daemon", async () => {
		const s = put({ name: "api", status: "working" });
		storage.conversation.append({
			repo: REPO,
			from: "master",
			text: "To #eng:\n\n> api is done\n\nSend it when api finishes?",
			at: 1,
		});
		storage.conversation.append({
			repo: REPO,
			from: "you",
			text: "yes",
			at: 2,
		});
		await master.handleTool(REPO, "watch_session", {
			session: "api",
			note: "send it",
			slack_text: "api is done",
		});
		master.message(REPO, "hi");
		runner.emit({ type: "session", sessionId: "chat-1" });
		result();
		restartDaemon();
		change(s.id, { status: "idle", lastAssistantMessage: "Done." });
		expect(runner.resumes).toEqual([null, "chat-1"]);
		expect(runner.sent.at(-1)).toContain("serenity: api is now idle");
		restartDaemon();
		const sent = await master.handleTool(REPO, "request_permission", {
			tool_name: "mcp__slack__slack_send_message",
			input: { message: "api is done" },
		});
		expect(JSON.parse(sent.text).behavior).toBe("allow");
	});

	test("messages not yet answered are delivered when the daemon starts again", () => {
		master.message(REPO, "first");
		master.message(REPO, "second");
		restartDaemon();
		expect(runner.chatStarts).toBe(1);
		master.start();
		expect(runner.chatStarts).toBe(2);
		expect(runner.sent.at(-1)).toContain("User: first");
		result();
		expect(runner.sent.at(-1)).toContain("User: second");
		result();
		expect(storage.master.get(REPO)?.outbox).toEqual([]);
	});

	test("a tool that hangs answers with an error after the tool timeout", async () => {
		jest.useFakeTimers();
		put({ name: "api", status: "idle" });
		host.open = () => new Promise(() => {});
		const out = master.handleTool(REPO, "open_session", { session: "api" });
		jest.advanceTimersByTime(TOOL_TIMEOUT_MS);
		expect(await out).toMatchObject({ isError: true });
		expect((await out).text).toContain("Check session_status");
	});

	test("a tool that throws answers with an error instead", async () => {
		put({ name: "api", status: "idle" });
		host.open = async () => {
			throw new Error("tmux is gone");
		};
		expect(
			await master.handleTool(REPO, "open_session", { session: "api" }),
		).toEqual({ text: "open_session failed: tmux is gone", isError: true });
	});
});

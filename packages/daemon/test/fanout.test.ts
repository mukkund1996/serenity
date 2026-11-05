/** Fan-out (ADR 0060): an agent's request_sessions, its proposal, and reports to the parent. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CreateSessionParams,
	createMemoryStorage,
	type HookKind,
	type Session,
} from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import { Daemon } from "../src/daemon";
import { Fanout } from "../src/fanout";
import { MasterSupervisor } from "../src/master";

const PROMPT =
	"Write unit tests for packages/core/src/fanout.ts covering every rule; open a PR.";
const two = [
	{ name: "kid-a", prompt: PROMPT },
	{ name: "kid-b", prompt: PROMPT },
];

function setup(parent: Partial<Session> = {}) {
	const storage = createMemoryStorage();
	const created: CreateSessionParams[] = [];
	const sent: Array<{ name: string; text: string }> = [];
	const fanout = new Fanout({
		storage,
		now: () => 1,
		log: () => {},
		broadcast: () => {},
		create: async (params) => {
			if (params.name === "taken") throw new Error("name in use");
			created.push(params);
			const s = makeSession({
				id: `id-${params.name}`,
				name: params.name,
				parentId: params.parentId ?? null,
				topic: params.topic ?? null,
				status: "working",
			});
			storage.sessions.put(s);
			return s;
		},
		send: async (session, text) => {
			sent.push({ name: session.name, text });
		},
	});
	storage.sessions.put(
		makeSession({ id: "p", name: "lead", topic: "api", ...parent }),
	);
	const prompt = (text: string, kind: HookKind = "UserPromptSubmit") =>
		storage.events.append({
			sessionId: "p",
			kind,
			payload: { prompt: text },
			at: 1,
		});
	const ask = (args: Record<string, unknown>, sessionId = "p") =>
		fanout.tool(sessionId, "request_sessions", args);
	const pending = () => storage.suggestions.listPending("/repos/demo");
	const flush = () => new Promise((r) => setTimeout(r, 0));
	return { storage, fanout, created, sent, prompt, ask, pending, flush };
}

describe("request_sessions", () => {
	test("starts at once when the user's latest prompt asked for sessions", async () => {
		const t = setup();
		t.prompt("split this into 2 sessions");
		const result = await t.ask({
			sessions: two,
			reason: "two parts",
			user_asked: true,
		});
		expect(result.isError).toBe(false);
		expect(result.text).toContain("Started kid-a, kid-b");
		expect(t.created).toEqual([
			expect.objectContaining({
				name: "kid-a",
				mode: "worktree",
				cwd: "/repos/demo",
				prompt: PROMPT,
				parentId: "p",
				topic: "api",
			}),
			expect.objectContaining({ name: "kid-b", parentId: "p" }),
		]);
		expect(t.pending()).toEqual([]);
	});

	test("an agent's own idea waits in NEEDS YOU", async () => {
		const t = setup();
		t.prompt("refactor the auth module");
		const result = await t.ask({ sessions: two, reason: "big task" });
		expect(result.text).toContain("waits in the user's NEEDS YOU");
		expect(t.created).toEqual([]);
		expect(t.pending()).toEqual([
			expect.objectContaining({
				kind: "fanout",
				sessionId: "p",
				source: "agent",
				label: "Start 2 sessions: kid-a, kid-b",
				sessions: two,
			}),
		]);
	});

	test("claiming the user asked is not enough", async () => {
		const t = setup();
		t.prompt("refactor the auth module");
		const result = await t.ask({
			sessions: two,
			reason: "x",
			user_asked: true,
		});
		expect(result.text).toContain("did not ask for new sessions");
		expect(t.created).toEqual([]);
		expect(t.pending()).toHaveLength(1);
	});

	test("serenity's own report is not the user asking", async () => {
		const t = setup();
		t.prompt("[serenity] From the sessions you started: kid has ended");
		await t.ask({ sessions: two, reason: "x", user_asked: true });
		expect(t.created).toEqual([]);
	});

	test("a new request replaces the parent's earlier proposal", async () => {
		const t = setup();
		await t.ask({ sessions: two, reason: "x" });
		await t.ask({ sessions: [two[0]], reason: "y" });
		expect(t.pending().map((g) => g.label)).toEqual(["Start 1 session: kid-a"]);
	});

	test("a child cannot fan out, and unknown sessions are refused", async () => {
		const t = setup({ parentId: "someone" });
		const child = await t.ask({ sessions: two, reason: "x" });
		expect(child).toMatchObject({ isError: true });
		expect(child.text).toContain("cannot fan out itself");
		const stranger = await t.ask({ sessions: two, reason: "x" }, "nobody");
		expect(stranger.isError).toBe(true);
	});

	test("a name already on the map is refused before anything starts", async () => {
		const t = setup();
		const result = await t.ask({
			sessions: [{ name: "lead", prompt: PROMPT }],
			reason: "x",
		});
		expect(result).toMatchObject({ isError: true });
		expect(t.pending()).toEqual([]);
	});
});

describe("accepting and declining", () => {
	test("y starts the sessions and tells the parent", async () => {
		const t = setup();
		await t.ask({ sessions: two, reason: "x" });
		const [g] = t.pending();
		await t.fanout.accept(g as NonNullable<typeof g>);
		expect(t.created.map((c) => c.name)).toEqual(["kid-a", "kid-b"]);
		await t.flush();
		expect(t.sent).toEqual([
			{
				name: "lead",
				text: expect.stringContaining("the user started kid-a, kid-b"),
			},
		]);
	});

	test("a session that cannot start is named; none starting throws", async () => {
		const t = setup();
		await t.ask({ sessions: [{ name: "taken", prompt: PROMPT }], reason: "x" });
		const [g] = t.pending();
		await expect(t.fanout.accept(g as NonNullable<typeof g>)).rejects.toThrow(
			"name in use",
		);
	});

	test("n tells the parent the user said no", async () => {
		const t = setup();
		await t.ask({ sessions: two, reason: "x" });
		const [g] = t.pending();
		t.fanout.declined(g as NonNullable<typeof g>);
		await t.flush();
		expect(t.sent[0]?.text).toContain("declined starting kid-a, kid-b");
	});
});

describe("reports to the parent", () => {
	const kid = makeSession({
		id: "k",
		name: "kid",
		parentId: "p",
		status: "working",
	});

	test("a child's finished turn reaches an idle parent", async () => {
		const t = setup();
		t.fanout.onSessionChanged(kid, {
			...kid,
			status: "idle",
			lastAssistantMessage: "Opened PR #9",
		});
		await t.flush();
		expect(t.sent).toEqual([
			{
				name: "lead",
				text: expect.stringContaining("kid finished its turn: Opened PR #9"),
			},
		]);
	});

	test("a working parent hears it all at once when its turn ends", async () => {
		const t = setup({ status: "working" });
		t.fanout.onSessionChanged(kid, { ...kid, status: "idle" });
		t.fanout.onSessionChanged(kid, { ...kid, status: "dead" });
		await t.flush();
		expect(t.sent).toEqual([]);
		const parent = t.storage.sessions.get("p") as Session;
		const idle = { ...parent, status: "idle" as const };
		t.storage.sessions.put(idle);
		t.fanout.onSessionChanged(parent, idle);
		await t.flush();
		expect(t.sent).toHaveLength(1);
		expect(t.sent[0]?.text).toContain("kid finished its turn | kid has ended");
	});

	test("a parent waiting on the user is not typed into", async () => {
		const t = setup({ status: "waiting", waitingOn: "question" });
		t.fanout.onSessionChanged(kid, { ...kid, status: "idle" });
		await t.flush();
		expect(t.sent).toEqual([]);
	});
});

describe("in the daemon", () => {
	const home = mkdtempSync(join(tmpdir(), "sfanout-"));
	afterAll(() => rmSync(home, { recursive: true, force: true }));

	test("children follow their parent's topic", () => {
		const storage = createMemoryStorage();
		const daemon = new Daemon({ home, storage, log: () => {} });
		const change = (
			daemon as unknown as {
				change(s: Session, p: Partial<Session>): Session;
			}
		).change.bind(daemon);
		const parent = makeSession({ id: "p", name: "lead", topic: "api" });
		storage.sessions.put(parent);
		storage.sessions.put(
			makeSession({ id: "k", name: "kid", topic: "api", parentId: "p" }),
		);
		change(parent, { topic: "auth" });
		expect(storage.sessions.get("k")?.topic).toBe("auth");
	});

	test("the master never supersedes a fanout request", () => {
		const storage = createMemoryStorage();
		storage.sessions.put(makeSession({ id: "p" }));
		storage.suggestions.put({
			id: "f",
			repo: "/repos/demo",
			sessionId: "p",
			kind: "fanout",
			label: "Start 1 session: a",
			text: null,
			sessions: [{ name: "a", prompt: PROMPT }],
			status: "pending",
			source: "agent",
			createdAt: 1,
			updatedAt: 1,
		});
		const master = new MasterSupervisor(
			{
				storage,
				now: () => 2,
				log: () => {},
				broadcast: () => {},
			} as unknown as ConstructorParameters<typeof MasterSupervisor>[0],
			{} as ConstructorParameters<typeof MasterSupervisor>[1],
		);
		master.supersede("p");
		expect(storage.suggestions.get("f")?.status).toBe("pending");
		master.supersede("p", "fanout");
		expect(storage.suggestions.get("f")?.status).toBe("superseded");
	});
});

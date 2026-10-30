import { describe, expect, test } from "bun:test";
import {
	askable,
	confirmedReply,
	confirmedSlackSend,
	parseSlackInbox,
	parseSlackSuggestion,
	relatedSessions,
	SLACK_LOGIN_HINT,
	type SlackItem,
	slackContext,
	slackInboxPrompt,
	slackMessageKey,
	slackReplyTarget,
	slackSendPrompt,
	slackSessionName,
	slackSuggestionLine,
	slackSuggestionPrompt,
	slackTsMs,
} from "../src/slack";
import { makeSession } from "../test-support";

const item = (over: Record<string, unknown> = {}) => ({
	channelId: "C1",
	channel: "#eng",
	author: "Ana",
	text: "can you check\nthe deploy?",
	reason: "mention",
	action: "Check the deploy",
	ts: "1730000000.000100",
	threadTs: "1730000000.000100",
	permalink: "https://x.slack.com/archives/C1/p1730000000000100",
	...over,
});

test("items come back newest first, one per thread, at most three", () => {
	const raw = {
		access: "ok",
		problem: null,
		items: [
			item(),
			item({ ts: "1730000500.0", threadTs: "1730000000.000100" }),
			...[1, 2, 3, 4, 5].map((n) =>
				item({ channelId: `C${n + 1}`, ts: `17300001${n}0.0`, threadTs: "" }),
			),
		],
	};
	const inbox = parseSlackInbox(raw);
	expect(inbox?.error).toBeNull();
	expect(inbox?.items).toHaveLength(3);
	expect(inbox?.items[0]?.id).toBe("C1:1730000000.000100");
	expect(inbox?.items[0]?.ts).toBe("1730000500.0");
	expect(inbox?.items[0]?.text).toBe("can you check the deploy?");
	expect(inbox?.items[0]?.action).toBe("Check the deploy");
	// A message outside a thread is its own thread.
	expect(inbox?.items[1]?.threadTs).toBe(inbox?.items[1]?.ts);
});

test("unusable entries are skipped; an unusable answer is null", () => {
	const inbox = parseSlackInbox({
		access: "ok",
		problem: null,
		items: [item({ channelId: "" }), item({ reason: "dm", permalink: "" })],
	});
	expect(inbox?.items).toHaveLength(1);
	expect(inbox?.items[0]?.reason).toBe("dm");
	expect(inbox?.items[0]?.permalink).toBeNull();
	expect(parseSlackInbox("nope")).toBeNull();
	expect(parseSlackInbox({ access: "ok" })).toBeNull();
});

test("only mentions and DMs with something to do get in", () => {
	const inbox = parseSlackInbox({
		access: "ok",
		problem: null,
		items: [
			item({ channelId: "C1", reason: "thread" }),
			item({ channelId: "C2", action: " " }),
			item({ channelId: "C3", reason: "dm" }),
			item({ channelId: "C4" }),
		],
	});
	expect(inbox?.items.map((i) => i.channelId).sort()).toEqual(["C3", "C4"]);
});

test("a message the user wrote after, where they saw it, means it was read", () => {
	const inbox = parseSlackInbox({
		access: "ok",
		problem: null,
		items: [
			item({ channelId: "C1", lastOwnTs: "1730000100.0" }),
			item({ channelId: "C2", lastOwnTs: "1729999000.0" }),
			item({ channelId: "C3", lastOwnTs: null }),
			item({ channelId: "C4", lastOwnTs: "1730000000.000100" }),
		],
	});
	// Only a later message counts: an earlier one, none, or the same ts do not.
	expect(inbox?.items.map((i) => i.channelId).sort()).toEqual([
		"C2",
		"C3",
		"C4",
	]);
	expect(slackInboxPrompt(Date.UTC(2026, 9, 28))).toContain(
		"lastOwnTs: the ts of the user's newest message where they would have seen this one",
	);
});

test("the inbox prompt asks for mentions and DMs that need action, and few", () => {
	const prompt = slackInboxPrompt(Date.UTC(2026, 9, 28));
	expect(prompt).toContain("since 2026-10-21");
	expect(prompt).toContain("direct messages");
	expect(prompt).toContain("When unsure, drop it.");
	expect(prompt).toContain("at most 3");
	expect(prompt).not.toMatch(/threads the user replied/i);
	expect(prompt).not.toContain("dismissed");
});

test("the inbox prompt skips dismissed messages from the last week", () => {
	const now = Date.UTC(2026, 9, 28);
	const recent = String(now / 1000 - 3600);
	const old = String(now / 1000 - 8 * 24 * 3600);
	const prompt = slackInboxPrompt(now, [
		{ channelId: "C1", ts: recent, at: now },
		{ channelId: "C2", ts: old, at: now },
	]);
	expect(prompt).toContain("dismissed");
	expect(prompt).toContain(`C1 ${recent}`);
	expect(prompt).not.toContain("C2");
	expect(prompt).toContain(
		"a newer message in the same thread or DM still counts",
	);
});

test("a message's key is its channel and ts", () => {
	expect(slackMessageKey({ channelId: "C1", ts: "1.5" })).toBe("C1@1.5");
	expect(slackMessageKey({ channelId: "C1", ts: "1.5" })).not.toBe(
		slackMessageKey({ channelId: "C1", ts: "1.6" }),
	);
});

test("no access says how to log in when it is an auth problem", () => {
	expect(
		parseSlackInbox({ access: "no_access", problem: "needs auth", items: [] }),
	).toEqual({ items: [], error: SLACK_LOGIN_HINT });
	expect(
		parseSlackInbox({ access: "no_access", problem: "rate limited", items: [] })
			?.error,
	).toBe("Slack: rate limited");
});

test("Slack timestamps become ms", () => {
	expect(slackTsMs("1730000000.5")).toBe(1730000000500);
	expect(slackTsMs("x")).toBe(0);
});

describe("suggestions", () => {
	const slackItem = parseSlackInbox({
		access: "ok",
		problem: null,
		items: [item()],
	})?.items[0] as SlackItem;
	const idle = makeSession({
		id: "s1",
		name: "api-auth",
		status: "idle",
		tmuxPane: "%1",
		summary: "Fixed the token refresh.",
	});
	const working = makeSession({
		id: "s2",
		name: "billing",
		status: "working",
		tmuxPane: "%2",
	});

	test("only a live agent that is free can be asked", () => {
		expect(askable(idle)).toBe(true);
		expect(askable(working)).toBe(false);
		expect(askable({ ...idle, tmuxPane: null })).toBe(false);
		expect(askable({ ...idle, status: "archived" })).toBe(false);
		expect(
			askable({ ...idle, status: "waiting", waitingOn: "permission" }),
		).toBe(false);
	});

	test("the context names every session and who can be told", () => {
		const text = slackContext([idle, working], []);
		expect(text).toContain("api-auth [unsorted] idle (can be told)");
		expect(text).toContain("summary: Fixed the token refresh.");
		expect(text).toContain("- billing [unsorted] working · branch");
		expect(text).not.toContain("billing [unsorted] working (can be told)");
		expect(text).not.toContain("The message names");
	});

	test("sessions a message names by name, branch or PR are pointed out", () => {
		const pr = makeSession({
			id: "s3",
			name: "fix-login",
			branch: "login-redirect",
			pr: {
				number: 42,
				url: "https://github.com/o/r/pull/42",
				title: "Fix login",
				state: "OPEN",
				isDraft: false,
				checks: "passing",
				reviewDecision: null,
				reviewRequests: [],
				reviewed: false,
			} as never,
		});
		const about = (text: string) =>
			relatedSessions({ ...slackItem, text, action: "Answer" }, [
				idle,
				{ ...working, branch: "billing" },
				pr,
			]).map((s) => s.name);
		expect(about("is api-auth done?")).toEqual(["api-auth"]);
		expect(about("what about #42")).toEqual(["fix-login"]);
		expect(about("see https://github.com/o/r/pull/42 pls")).toEqual([
			"fix-login",
		]);
		expect(about("the login-redirect branch is red")).toEqual(["fix-login"]);
		// A name inside another word, or another PR number, is not a match.
		expect(about("my-api-auth-v2 and #421")).toEqual([]);
		expect(
			slackContext([idle, pr], [], { ...slackItem, text: "#42 shipped?" }),
		).toContain(
			"The message names these sessions by name, branch or PR: fix-login.",
		);
	});

	test("a name shared with an archived session means the live one", () => {
		const archived = makeSession({ id: "old", status: "archived" });
		const reply = {
			kind: "reply",
			text: "yes",
			session: "api-auth",
			name: null,
		};
		expect(
			parseSlackSuggestion(reply, slackItem, [archived, idle], false),
		).toMatchObject({ sessionId: "s1" });
		expect(
			parseSlackSuggestion(reply, slackItem, [idle, archived], false),
		).toMatchObject({ sessionId: "s1" });
	});

	test("a reply, a message to a free session, or a new session; nothing else", () => {
		const reply = parseSlackSuggestion(
			{ kind: "reply", text: "yes", session: "api-auth", name: null },
			slackItem,
			[idle],
			false,
		);
		expect(reply).toMatchObject({
			kind: "reply",
			action: "Reply in #eng thread",
			sessionId: "s1",
			text: "yes",
		});
		const tell = { kind: "tell", text: "shipped?", session: "", name: null };
		expect(
			parseSlackSuggestion(
				{ ...tell, session: "api-auth" },
				slackItem,
				[idle],
				false,
			),
		).toMatchObject({
			kind: "tell",
			action: "Tell api-auth",
			sessionId: "s1",
			status: "pending",
		});
		// A working session cannot take a message.
		expect(
			parseSlackSuggestion(
				{ ...tell, session: "billing" },
				slackItem,
				[working],
				false,
			),
		).toBeNull();
		expect(
			parseSlackSuggestion(
				{
					kind: "start",
					text: "Fix the login redirect Ana reported.",
					session: null,
					name: "Fix Login Redirect!",
				},
				slackItem,
				[],
				false,
			),
		).toMatchObject({
			kind: "start",
			action: "Start new session fix-login-redirect",
			name: "fix-login-redirect",
			sessionId: null,
		});
		expect(
			parseSlackSuggestion(
				{ kind: "start", text: "brief", session: null, name: "!!" },
				slackItem,
				[],
				false,
			),
		).toBeNull();
		// After the session answered, only a reply is taken.
		expect(
			parseSlackSuggestion(
				{ ...tell, session: "api-auth" },
				slackItem,
				[idle],
				true,
			),
		).toBeNull();
		expect(
			parseSlackSuggestion(
				{ kind: "start", text: "brief", session: null, name: "x" },
				slackItem,
				[],
				true,
			),
		).toBeNull();
		expect(
			parseSlackSuggestion(
				{ kind: "none", text: "y", session: null, name: null },
				slackItem,
				[],
				false,
			),
		).toBeNull();
	});

	test("the action line says what y does, and where", () => {
		const dm = { ...slackItem, reason: "dm" as const, channel: "Dana" };
		expect(slackReplyTarget(slackItem)).toBe("Reply in #eng thread");
		expect(slackReplyTarget(dm)).toBe("Reply to Dana in DM");
		expect(slackReplyTarget({ ...dm, threadTs: "1.0" })).toBe(
			"Reply in DM thread with Dana",
		);
		const g = {
			itemId: slackItem.id,
			kind: "tell" as const,
			action: "Tell api-auth",
			text: "did it ship?",
			sessionId: "s1",
			name: null,
			status: "pending" as const,
		};
		expect(slackSuggestionLine(g)).toBe("Tell api-auth: did it ship?");
		expect(
			slackSuggestionLine({ ...g, status: "asked", action: "Told api-auth" }),
		).toBe("Told api-auth");
		expect(slackSuggestionLine({ ...g, status: "sending" })).toBe(
			"Sending to Slack…",
		);
		expect(slackSessionName("  Fix: the Login  ")).toBe("fix-the-login");
		expect(slackSessionName(null)).toBeNull();
	});

	test("a DM's own message is answered in the DM, anything else in its thread", () => {
		const dm = { ...slackItem, reason: "dm" as const };
		expect(slackSendPrompt(dm, "ok")).toContain("not in a thread");
		expect(slackSendPrompt({ ...dm, threadTs: "1.0" }, "ok")).toContain(
			"thread with ts 1.0",
		);
		expect(slackSendPrompt(slackItem, "ok")).toContain(
			"Post a reply in the Slack thread",
		);
	});

	test("the follow-up prompt carries the session's answer", () => {
		const prompt = slackSuggestionPrompt(slackItem, "ctx", {
			session: "api-auth",
			question: "shipped?",
			answer: "Yes, in #42.",
		});
		expect(prompt).toContain("It answered: Yes, in #42.");
		expect(prompt).not.toContain("- tell:");
		expect(prompt).not.toContain("- start:");
		expect(slackSendPrompt(slackItem, "merged")).toContain("<<<\nmerged\n>>>");
	});
});

describe("confirmedSlackSend", () => {
	const msg = (from: "you" | "master", text: string, id: number) => ({
		id,
		repo: "/r",
		from,
		text,
		at: id,
	});
	const draft = msg(
		"master",
		"To #eng, in the thread from Dana:\n\n> merged in #42,\n> deploys today\n\nSend it?",
		1,
	);

	test("sends the text shown in the reply the user just answered", () => {
		expect(
			confirmedSlackSend(
				[draft, msg("you", "yes", 2)],
				"merged in #42, deploys today",
			),
		).toBe(true);
		expect(
			confirmedSlackSend(
				[draft, msg("you", "yes", 2)],
				"merged in #42,\ndeploys today",
			),
		).toBe(true);
	});

	test("asks again for text the user did not see", () => {
		const said = [draft, msg("you", "yes", 2)];
		expect(confirmedSlackSend(said, "merged in #42, deploys tomorrow")).toBe(
			false,
		);
		expect(confirmedSlackSend(said, "")).toBe(false);
		expect(confirmedSlackSend(said, undefined)).toBe(false);
	});

	test("asks again when the user has not answered the draft", () => {
		expect(confirmedSlackSend([draft], "merged in #42, deploys today")).toBe(
			false,
		);
		expect(
			confirmedSlackSend(
				[msg("you", "draft it", 0), msg("you", "yes", 2)],
				"merged in #42, deploys today",
			),
		).toBe(false);
	});
});

describe("confirmedReply", () => {
	const msg = (from: "you" | "master", text: string, id: number) => ({
		id,
		repo: "/r",
		from,
		text,
		at: id,
	});

	test("sends text the user's latest message contains as whole words", () => {
		const asked = [msg("you", "tell api-auth 'use 15m'", 1)];
		expect(confirmedReply(asked, "use 15m")).toBe(true);
		expect(confirmedReply([msg("you", "tell it yes", 1)], "yes")).toBe(true);
		expect(confirmedReply(asked, "use 15")).toBe(false);
		expect(confirmedReply(asked, "use 15m now")).toBe(false);
		expect(confirmedReply([msg("you", "a.b", 1)], "a*b")).toBe(false);
	});

	test("sends text the master showed and the user then confirmed", () => {
		const shown = msg(
			"master",
			"To dismiss-slack-item:\n\n> Ask me questions before you change anything.\n\nSend it?",
			1,
		);
		const text = "Ask me questions before you change anything.";
		expect(confirmedReply([shown, msg("you", "just send it", 2)], text)).toBe(
			true,
		);
		expect(confirmedReply([shown], text)).toBe(false);
		expect(
			confirmedReply([shown, msg("you", "yes", 2)], "Ask me questions."),
		).toBe(false);
	});

	test("never sends empty text or text the user neither wrote nor saw", () => {
		expect(confirmedReply([msg("you", "tell it to add tests", 1)], "")).toBe(
			false,
		);
		expect(
			confirmedReply(
				[msg("you", "tell it to add tests", 1)],
				"Please add unit tests.",
			),
		).toBe(false);
		expect(confirmedReply([], "yes")).toBe(false);
	});
});

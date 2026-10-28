import { describe, expect, test } from "bun:test";
import {
	askable,
	confirmedSlackSend,
	parseSlackInbox,
	parseSlackSuggestion,
	SLACK_LOGIN_HINT,
	type SlackItem,
	slackContext,
	slackInboxPrompt,
	slackSendPrompt,
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

test("the inbox prompt asks for mentions and DMs that need action, and few", () => {
	const prompt = slackInboxPrompt(Date.UTC(2026, 9, 28));
	expect(prompt).toContain("since 2026-10-21");
	expect(prompt).toContain("direct messages");
	expect(prompt).toContain("When unsure, drop it.");
	expect(prompt).toContain("at most 3");
	expect(prompt).not.toMatch(/threads the user replied/i);
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

	test("the context names every session and who can be asked", () => {
		const text = slackContext([idle, working], []);
		expect(text).toContain("api-auth [unsorted] idle (can be asked)");
		expect(text).toContain("summary: Fixed the token refresh.");
		expect(text).toContain("- billing [unsorted] working · branch");
		expect(text).not.toContain("billing [unsorted] working (can be asked)");
	});

	test("a reply or an ask to a free session; nothing else", () => {
		const reply = parseSlackSuggestion(
			{ kind: "reply", label: 'Reply "yes"', text: "yes", session: "api-auth" },
			slackItem,
			[idle],
			false,
		);
		expect(reply).toMatchObject({
			kind: "reply",
			sessionId: "s1",
			text: "yes",
		});
		const ask = { kind: "ask", label: "Ask", text: "shipped?", session: "" };
		expect(
			parseSlackSuggestion(
				{ ...ask, session: "api-auth" },
				slackItem,
				[idle],
				false,
			),
		).toMatchObject({ kind: "ask", sessionId: "s1", status: "pending" });
		expect(
			parseSlackSuggestion(
				{ ...ask, session: "billing" },
				slackItem,
				[working],
				false,
			),
		).toBeNull();
		// After the session answered, only a reply is taken.
		expect(
			parseSlackSuggestion(
				{ ...ask, session: "api-auth" },
				slackItem,
				[idle],
				true,
			),
		).toBeNull();
		expect(
			parseSlackSuggestion(
				{ kind: "none", label: "x", text: "y", session: null },
				slackItem,
				[],
				false,
			),
		).toBeNull();
	});

	test("the follow-up prompt carries the session's answer", () => {
		const prompt = slackSuggestionPrompt(slackItem, "ctx", {
			session: "api-auth",
			question: "shipped?",
			answer: "Yes, in #42.",
		});
		expect(prompt).toContain("It answered: Yes, in #42.");
		expect(prompt).not.toContain("- ask:");
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

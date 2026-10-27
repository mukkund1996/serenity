import { expect, test } from "bun:test";
import { parseSlackInbox, SLACK_LOGIN_HINT, slackTsMs } from "../src/slack";

const item = (over: Record<string, unknown> = {}) => ({
	channelId: "C1",
	channel: "#eng",
	author: "Ana",
	text: "can you check\nthe deploy?",
	reason: "mention",
	ts: "1730000000.000100",
	threadTs: "1730000000.000100",
	permalink: "https://x.slack.com/archives/C1/p1730000000000100",
	...over,
});

test("items come back newest first, one per thread, at most five", () => {
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
	expect(inbox?.items).toHaveLength(5);
	expect(inbox?.items[0]?.id).toBe("C1:1730000000.000100");
	expect(inbox?.items[0]?.ts).toBe("1730000500.0");
	expect(inbox?.items[0]?.text).toBe("can you check the deploy?");
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
	expect(inbox?.items[0]?.reason).toBe("thread");
	expect(inbox?.items[0]?.permalink).toBeNull();
	expect(parseSlackInbox("nope")).toBeNull();
	expect(parseSlackInbox({ access: "ok" })).toBeNull();
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

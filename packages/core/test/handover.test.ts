import { describe, expect, test } from "bun:test";
import type { HandoverDoc, MasterMessage } from "../src/domain";
import {
	confirmedFileShare,
	freshHandover,
	handoverDraftPath,
	handoverFileName,
	handoverPrompt,
	handoverRequest,
} from "../src/handover";
import { handoversDir } from "../src/paths";
import { makeSession } from "../test-support";

const session = makeSession({
	id: "a",
	name: "api-auth",
	cwd: "/wt/api-auth",
	status: "idle",
	lastAssistantMessage: "Wrote it.",
});

describe("handover paths", () => {
	test("the agent writes in its worktree; serenity keeps copies per repo", () => {
		expect(handoverDraftPath(session)).toBe(
			"/wt/api-auth/.serenity/handover.md",
		);
		expect(handoversDir("/home", "/repos/My Repo")).toBe(
			"/home/handovers/my-repo",
		);
		expect(handoverFileName(session, Date.UTC(2026, 9, 30, 14, 15, 2))).toBe(
			"api-auth-20261030-141502.md",
		);
	});
});

describe("handoverRequest", () => {
	test("names the file, the sections and the follow-up", () => {
		const text = handoverRequest(session, "add the docs page");
		expect(text).toContain("write /wt/api-auth/.serenity/handover.md");
		expect(text).toContain(
			"Goal; State (what is done, what is not, what is in flight); Decisions (and why); Open questions; Key files, branches and PRs",
		);
		expect(text).toContain(
			"The next steps are for this follow-up: add the docs page",
		);
		expect(text).toContain("change nothing else");
		expect(handoverRequest(session, null)).toContain(
			"for whoever continues this work",
		);
	});
});

describe("freshHandover", () => {
	const doc: HandoverDoc = {
		sessionId: "a",
		sessionName: "api-auth",
		path: "/h/api-auth.md",
		at: 1,
		reply: "Wrote it.",
	};

	test("is fresh while the session has replied nothing since", () => {
		expect(freshHandover(doc, session)).toBe(true);
	});

	test("goes stale with a new reply, while working, or for another session", () => {
		expect(
			freshHandover(doc, { ...session, lastAssistantMessage: "More." }),
		).toBe(false);
		expect(freshHandover(doc, { ...session, status: "working" })).toBe(false);
		expect(freshHandover({ ...doc, sessionId: "b" }, session)).toBe(false);
		expect(freshHandover(undefined, session)).toBe(false);
	});
});

test("handoverPrompt puts the doc after the master's prompt", () => {
	expect(handoverPrompt("Add docs.", "api-auth", "# Goal\n")).toBe(
		"Add docs.\n\nHandover from session api-auth, which worked on this before you:\n\n<handover>\n# Goal\n</handover>",
	);
});

describe("confirmedFileShare", () => {
	const msg = (from: "you" | "master", text: string): MasterMessage => ({
		id: 1,
		repo: "/r",
		from,
		text,
		at: 1,
	});
	const share = {
		path: "/h/api-auth-1.md",
		channelId: "C0ENG",
		comment: "handover   for api-auth",
	};
	const draft = msg(
		"master",
		"Share api-auth-1.md to #eng (C0ENG) with:\n\n> handover for api-auth\n\nShare it?",
	);

	test("needs the user's answer to a draft that showed file, channel ID and comment", () => {
		expect(confirmedFileShare([draft, msg("you", "yes")], share)).toBe(true);
		expect(
			confirmedFileShare([draft, msg("you", "yes")], {
				...share,
				comment: null,
			}),
		).toBe(true);
	});

	test("anything else is not confirmed", () => {
		expect(confirmedFileShare([draft], share)).toBe(false);
		expect(
			confirmedFileShare([msg("you", "x"), msg("you", "yes")], share),
		).toBe(false);
		const yes = msg("you", "yes");
		expect(
			confirmedFileShare([draft, yes], { ...share, channelId: "C0OTHER" }),
		).toBe(false);
		expect(
			confirmedFileShare([draft, yes], { ...share, path: "/h/other.md" }),
		).toBe(false);
		expect(confirmedFileShare([draft, yes], { ...share, comment: "hi" })).toBe(
			false,
		);
	});
});

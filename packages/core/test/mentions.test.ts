import { describe, expect, test } from "bun:test";
import type { MasterMessage } from "../src/domain";
import {
	applyCompletion,
	type Completion,
	commandHint,
	completionAt,
	completionOptions,
	isReservedName,
	masterCommands,
	matchMentions,
	mentionDraft,
	mentionedSessions,
	mentionSegments,
	mentionsSession,
	moveTopicSpan,
	parseMove,
} from "../src/mentions";
import { makeSession } from "../test-support";

const api = makeSession({ id: "api", name: "api-auth", status: "idle" });
const web = makeSession({ id: "web", name: "web-login", status: "working" });
const oldApi = makeSession({
	id: "old-api",
	name: "api-auth",
	status: "archived",
});
const gone = makeSession({ id: "gone", name: "retired", status: "archived" });
const ids = (list: { id: string }[]) => list.map((s) => s.id);

const msg = (from: "you" | "master", text: string): MasterMessage => ({
	id: 1,
	repo: "/r",
	from,
	text,
	at: 1,
});

describe("mentionedSessions", () => {
	test("finds sessions by exact name, once each, in order", () => {
		const text = "ask @web-login about @api-auth and @web-login again";
		expect(ids(mentionedSessions(text, [api, web]))).toEqual(["web", "api"]);
	});

	test("punctuation after a name is not part of it", () => {
		expect(
			ids(mentionedSessions("is @api-auth, done? @web-login.", [api, web])),
		).toEqual(["api", "web"]);
		expect(ids(mentionedSessions("(@api-auth)", [api]))).toEqual(["api"]);
	});

	test("a name that ends in punctuation still matches whole", () => {
		const odd = makeSession({ id: "odd", name: "v1.", status: "idle" });
		expect(ids(mentionedSessions("see @v1.", [odd]))).toEqual(["odd"]);
	});

	test("names are exact: a prefix, another case or an email mentions nothing", () => {
		expect(mentionedSessions("@api", [api])).toEqual([]);
		expect(mentionedSessions("@API-AUTH", [api])).toEqual([]);
		expect(mentionedSessions("mail me@api-auth", [api])).toEqual([]);
		expect(mentionedSessions("api-auth", [api])).toEqual([]);
		expect(mentionedSessions("@@api-auth", [api])).toEqual([]);
	});

	test("a name shared with an archived session means the live one", () => {
		expect(ids(mentionedSessions("@api-auth", [oldApi, api]))).toEqual(["api"]);
		expect(ids(mentionedSessions("@api-auth", [api, oldApi]))).toEqual(["api"]);
	});

	test("an archived session alone is not mentioned", () => {
		expect(mentionedSessions("@retired", [gone])).toEqual([]);
		expect(mentionedSessions("@api-auth", [oldApi])).toEqual([]);
	});
});

describe("mentionsSession", () => {
	test("is true when the user's latest message mentions the session", () => {
		const chat = [msg("master", "hi"), msg("you", "tell @api-auth to rebase")];
		expect(mentionsSession(chat, [api, web], api)).toBe(true);
		expect(mentionsSession(chat, [api, web], web)).toBe(false);
	});

	test("only the latest message counts, and only the user's", () => {
		const earlier = [msg("you", "@api-auth"), msg("you", "tell it yes")];
		expect(mentionsSession(earlier, [api], api)).toBe(false);
		const master = [msg("you", "x"), msg("master", "ask @api-auth?")];
		expect(mentionsSession(master, [api], api)).toBe(false);
		expect(mentionsSession([], [api], api)).toBe(false);
	});

	test("the archived twin of a mentioned name is not the mentioned session", () => {
		const chat = [msg("you", "tell @api-auth hi")];
		expect(mentionsSession(chat, [oldApi, api], oldApi)).toBe(false);
		expect(mentionsSession(chat, [oldApi, api], api)).toBe(true);
	});
});

describe("mentionDraft", () => {
	test("is the @word at the end of the text", () => {
		expect(mentionDraft("@")).toEqual({ query: "", start: 0 });
		expect(mentionDraft("ask @ap")).toEqual({ query: "ap", start: 4 });
		expect(mentionDraft("ask @api-au")).toEqual({ query: "api-au", start: 4 });
	});

	test("is null once the word ends or there is no @", () => {
		expect(mentionDraft("ask @api ")).toBeNull();
		expect(mentionDraft("ask api")).toBeNull();
		expect(mentionDraft("me@host")).toBeNull();
		expect(mentionDraft("@@x")).toBeNull();
		expect(mentionDraft("")).toBeNull();
	});
});

describe("matchMentions", () => {
	const sessions = [
		makeSession({ id: "1", name: "fix-login", status: "idle" }),
		makeSession({ id: "2", name: "login-page", status: "idle" }),
		makeSession({ id: "3", name: "api-auth", status: "idle" }),
		makeSession({ id: "4", name: "login-old", status: "archived" }),
		makeSession({ id: "5", name: "Auth-docs", status: "dead" }),
	];

	test("prefix matches come before substring matches", () => {
		expect(matchMentions(sessions, "login")).toEqual([
			"login-page",
			"fix-login",
		]);
		expect(matchMentions(sessions, "auth")).toEqual(["Auth-docs", "api-auth"]);
	});

	test("an empty query lists every command, then every live name", () => {
		expect(matchMentions(sessions, "")).toEqual([
			"new",
			"copy",
			"handover",
			"move",
			"fix-login",
			"login-page",
			"api-auth",
			"Auth-docs",
		]);
	});

	test("never offers an archived session, or the same name twice", () => {
		expect(matchMentions(sessions, "login-old")).toEqual([]);
		const twin = makeSession({ id: "6", name: "api-auth", status: "working" });
		expect(matchMentions([...sessions, twin], "api")).toEqual(["api-auth"]);
	});

	test("is empty when nothing matches", () => {
		expect(matchMentions(sessions, "zzz")).toEqual([]);
	});

	test("commands come first, by prefix only, and a session named like one never shows", () => {
		const news = makeSession({ id: "7", name: "newsletter", status: "idle" });
		const clash = makeSession({ id: "8", name: "New", status: "idle" });
		expect(matchMentions([...sessions, news, clash], "ne")).toEqual([
			"new",
			"newsletter",
		]);
		expect(matchMentions(sessions, "ew")).toEqual([]);
	});
});

describe("master commands (ADR 0048)", () => {
	test("finds each command once, in order, with punctuation after it", () => {
		expect(masterCommands("@new: add tests, then @new again")).toEqual(["new"]);
		expect(masterCommands("(@new) split the auth work")).toEqual(["new"]);
	});

	test("is exact and lowercase, and not glued to a word", () => {
		expect(masterCommands("@New add tests")).toEqual([]);
		expect(masterCommands("@newer add tests")).toEqual([]);
		expect(masterCommands("me@new.dev")).toEqual([]);
		expect(masterCommands("new add tests")).toEqual([]);
	});

	test("command words are reserved in any case", () => {
		expect(isReservedName("new")).toBe(true);
		expect(isReservedName("NEW")).toBe(true);
		expect(isReservedName("new-2")).toBe(false);
		expect(isReservedName("constructor")).toBe(false);
	});

	test("a command is never a session mention, even for a session so named", () => {
		const legacy = makeSession({ id: "n", name: "new", status: "idle" });
		expect(mentionedSessions("@new add tests", [legacy])).toEqual([]);
	});

	test("@copy and @handover are commands too (ADR 0049)", () => {
		expect(masterCommands("@copy @api-auth add docs")).toEqual(["copy"]);
		expect(masterCommands("@handover @api-auth")).toEqual(["handover"]);
		expect(matchMentions([], "h")).toEqual(["handover"]);
		expect(isReservedName("Copy")).toBe(true);
	});

	test("only commands have a hint", () => {
		expect(commandHint("new")).toBe("start sessions from a brief");
		expect(commandHint("api-auth")).toBeNull();
		expect(commandHint("toString")).toBeNull();
	});
});

describe("applyCompletion", () => {
	const complete = (text: string, name: string) =>
		applyCompletion(text, completionAt(text) as Completion, name);

	test("replaces the typed @word with the name and a space", () => {
		expect(complete("ask @ap", "api-auth")).toBe("ask @api-auth ");
		expect(complete("@", "api-auth")).toBe("@api-auth ");
		expect(complete("a @x and @lo", "login")).toBe("a @x and @login ");
	});
});

describe("mentionSegments", () => {
	const all = [api, web, oldApi, gone];
	const kinds = (text: string) =>
		mentionSegments(text, all).map((s) => [s.text, s.kind]);

	test("live session names and command words resolve; the rest is plain", () => {
		expect(kinds("@new fix login and tell @api-auth")).toEqual([
			["@new", "new"],
			[" fix login and tell ", null],
			["@api-auth", "session"],
		]);
		expect(kinds("@copy @web-login then @handover @api-auth")).toEqual([
			["@copy", "copy"],
			[" ", null],
			["@web-login", "session"],
			[" then ", null],
			["@handover", "handover"],
			[" ", null],
			["@api-auth", "session"],
		]);
	});

	test("unknown, archived-only, partial and miscased words stay plain", () => {
		for (const text of [
			"ask @nobody",
			"ask @retired",
			"ask @api",
			"@New and @COPY",
			"mail me@api-auth",
		])
			expect(kinds(text)).toEqual([[text, null]]);
	});

	test("punctuation after a mention stays plain", () => {
		expect(kinds("@api-auth, then @new: go.")).toEqual([
			["@api-auth", "session"],
			[", then ", null],
			["@new", "new"],
			[": go.", null],
		]);
		expect(kinds("@web-login.")).toEqual([
			["@web-login", "session"],
			[".", null],
		]);
	});

	test("segments join back to the text", () => {
		const text = "hi @api-auth. @x @copy- me@web-login @web-login";
		expect(
			mentionSegments(text, all)
				.map((s) => s.text)
				.join(""),
		).toBe(text);
		expect(mentionSegments("", all)).toEqual([]);
	});
});

describe("parseMove (ADR 0063)", () => {
	const sessions = [api, web];

	test("is null without @move", () => {
		expect(parseMove("@api-auth move to release", sessions)).toBeNull();
		expect(parseMove("@Move @api-auth release", sessions)).toBeNull();
	});

	test("one session and a topic", () => {
		expect(parseMove("@move @api-auth release", sessions)).toEqual({
			sessions: [api],
			unknown: [],
			topic: "release",
		});
	});

	test("several sessions at once, joined any way, with 'to'", () => {
		for (const text of [
			"@move @api-auth @web-login to release",
			"@move @api-auth, @web-login to release",
			"@move @api-auth and @web-login into the release topic",
			"@move @api-auth & @web-login: release",
			"@move to release @api-auth @web-login",
		]) {
			const move = parseMove(text, sessions);
			expect(move?.sessions.map((s) => s.name)).toEqual([
				"api-auth",
				"web-login",
			]);
			expect(move?.topic).toBe("release");
		}
	});

	test("a session mentioned twice moves once", () => {
		expect(
			parseMove("@move @api-auth @api-auth pr status", sessions)?.sessions,
		).toEqual([api]);
	});

	test("the topic stops at a clause break; quotes and words before @move are not part of it", () => {
		const topic = (text: string) => parseMove(text, sessions)?.topic;
		expect(topic("@move @api-auth to pr status, it's about checks")).toBe(
			"pr status",
		);
		expect(topic("@move @api-auth to v1.2 release. thanks")).toBe(
			"v1.2 release",
		);
		expect(topic('@move @api-auth "slack replies"')).toBe("slack replies");
		expect(topic("please @move @api-auth infra")).toBe("infra");
		expect(topic("@move @api-auth\nrelease")).toBeNull();
	});

	test("an unknown topic is kept as typed: whether it is new is the note's call", () => {
		expect(
			parseMove("@move @api-auth to brand new area", sessions)?.topic,
		).toBe("brand new area");
	});

	test("no topic, and @words that name no live session", () => {
		expect(parseMove("@move @api-auth", sessions)).toEqual({
			sessions: [api],
			unknown: [],
			topic: null,
		});
		expect(parseMove("@move @nobody @old-thing. release", sessions)).toEqual({
			sessions: [],
			unknown: ["nobody", "old-thing"],
			topic: "release",
		});
	});

	test("move is reserved like the other command words", () => {
		expect(isReservedName("move")).toBe(true);
		expect(isReservedName("MOVE")).toBe(true);
		expect(commandHint("move")).toBe("move sessions to a topic");
		expect(masterCommands("@move: @api-auth infra")).toEqual(["move"]);
	});

	test("@move is coloured as a command, its sessions as sessions", () => {
		expect(mentionSegments("@move @api-auth infra", sessions)).toEqual([
			{ text: "@move", kind: "move" },
			{ text: " ", kind: null },
			{ text: "@api-auth", kind: "session" },
			{ text: " infra", kind: null },
		]);
	});
});

describe("command completion (ADR 0067)", () => {
	const sessions = [api, web, gone];
	const topics = ["release", "auth work", "docs"];
	const offered = (before: string) => {
		const c = completionAt(before);
		return c ? completionOptions(c, sessions, topics) : [];
	};
	/** Types `before`, then picks `name` from the list. */
	const pick = (before: string, name: string) =>
		applyCompletion(before, completionAt(before) as Completion, name);

	test("an @ being typed completes commands and sessions, as before", () => {
		expect(completionAt("ask @ap")).toEqual({
			kind: "mention",
			query: "ap",
			start: 4,
		});
		expect(offered("@")).toEqual([
			"new",
			"copy",
			"handover",
			"move",
			"api-auth",
			"web-login",
		]);
		expect(pick("ask @ap", "api-auth")).toBe("ask @api-auth ");
		expect(completionAt("plain text")).toBeNull();
	});

	test("@copy and @handover then a space offer the live sessions, no @ needed", () => {
		for (const command of ["copy", "handover"]) {
			const before = `@${command} `;
			expect(completionAt(before)).toEqual({
				kind: "session",
				query: "",
				start: before.length,
			});
			expect(offered(before)).toEqual(["api-auth", "web-login"]);
			expect(pick(before, "web-login")).toBe(`@${command} @web-login `);
		}
		// The command alone, or a command word in the wrong case, offers nothing yet.
		expect(completionAt("@copy")?.kind).toBe("mention");
		expect(completionAt("@Copy ")).toBeNull();
	});

	test("the bare word after the command filters the sessions", () => {
		expect(completionAt("@copy we")).toEqual({
			kind: "session",
			query: "we",
			start: 6,
		});
		expect(offered("@copy we")).toEqual(["web-login"]);
		expect(offered("@copy login")).toEqual(["web-login"]);
		expect(pick("@copy we", "web-login")).toBe("@copy @web-login ");
		// A second word is free text: the list is gone.
		expect(completionAt("@copy the auth")).toBeNull();
		expect(offered("@copy zzz")).toEqual([]);
	});

	test("archived sessions and command words are never offered after a command", () => {
		expect(offered("@handover ret")).toEqual([]);
		expect(offered("@move ")).not.toContain("retired");
		expect(offered("@move ")).not.toContain("new");
	});

	test("@new takes no session: no list after it", () => {
		expect(completionAt("@new ")).toBeNull();
		expect(completionAt("@new fix")).toBeNull();
	});

	test("@copy @session leads on to the brief; @handover @session to nothing", () => {
		expect(completionAt("@copy @api-auth ")).toEqual({
			kind: "brief",
			query: "",
			start: 16,
		});
		expect(completionAt("@copy @api-auth fix it")).toBeNull();
		expect(completionAt("@handover @api-auth ")).toBeNull();
	});

	test("@move: sessions, then more on @, then to, then the topics", () => {
		// command → session list
		let text = "@move ";
		expect(completionAt(text)?.kind).toBe("session");
		text = pick(text, "api-auth");
		expect(text).toBe("@move @api-auth ");
		// → "to": no list, more sessions on @
		expect(completionAt(text)).toEqual({
			kind: "to",
			query: "",
			start: text.length,
		});
		expect(completionAt(`${text}@we`)?.kind).toBe("mention");
		text = pick(`${text}@we`, "web-login");
		expect(text).toBe("@move @api-auth @web-login ");
		expect(completionAt(text)?.kind).toBe("to");
		// → topic list once "to " follows (the TUI writes it on space or Tab)
		text += "to ";
		expect(completionAt(text)).toEqual({
			kind: "topic",
			query: "",
			start: text.length,
		});
		expect(offered(text)).toEqual(topics);
		expect(offered(`${text}au`)).toEqual(["auth work"]);
		expect(offered(`${text}work`)).toEqual(["auth work"]);
		expect(pick(`${text}au`, "auth work")).toBe(
			"@move @api-auth @web-login to auth work",
		);
		// A new name is just typed: nothing matches, nothing is offered.
		expect(offered(`${text}brand new`)).toEqual([]);
	});

	test("sessions joined by commas, and, & still lead on to the topics", () => {
		expect(completionAt("@move @api-auth, @web-login ")?.kind).toBe("to");
		expect(completionAt("@move @api-auth and @web-login ")?.kind).toBe("to");
		expect(completionAt("@move @api-auth & @web-login into ")?.kind).toBe(
			"topic",
		);
		// "to" needs a space after the last session, and the topic ends at a clause break.
		expect(completionAt("@move @api-auth")?.kind).toBe("mention");
		expect(completionAt("@move @api-auth to release, then")).toBeNull();
		expect(completionAt("@move @api-auth please ")).toBeNull();
	});

	test("the last command in the text counts", () => {
		expect(completionAt("@new a brief. @copy ")?.kind).toBe("session");
		expect(completionAt("@copy @api-auth then @new ")).toBeNull();
	});

	test("a topic is offered once, starts-with matches first", () => {
		const c = completionAt("@move @api-auth to d") as Completion;
		expect(completionOptions(c, sessions, ["xdocs", "docs", "docs"])).toEqual([
			"docs",
			"xdocs",
		]);
	});
});

describe("moveTopicSpan (ADR 0067)", () => {
	const sessions = [api, web];
	const span = (text: string) => {
		const at = moveTopicSpan(text, sessions);
		return at ? text.slice(at.start, at.end) : null;
	};

	test("where the topic @move reads sits in the text", () => {
		expect(span("@move @api-auth to release")).toBe("release");
		expect(span("@move @api-auth to the auth work topic")).toBe("auth work");
		expect(span("@move @api-auth")).toBeNull();
		expect(span("no command to release")).toBeNull();
	});

	test("never inside an @word, even when a session holds the topic's name", () => {
		const text = "@move @api-auth to api";
		const at = moveTopicSpan(text, sessions);
		expect(at).toEqual({ start: 19, end: 22 });
	});
});

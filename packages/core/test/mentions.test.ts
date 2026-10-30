import { describe, expect, test } from "bun:test";
import type { MasterMessage } from "../src/domain";
import {
	commandHint,
	completeMention,
	isReservedName,
	masterCommands,
	matchMentions,
	mentionDraft,
	mentionedSessions,
	mentionsSession,
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

	test("only commands have a hint", () => {
		expect(commandHint("new")).toBe("start sessions from a brief");
		expect(commandHint("api-auth")).toBeNull();
		expect(commandHint("toString")).toBeNull();
	});
});

describe("completeMention", () => {
	test("replaces the typed @word with the name and a space", () => {
		expect(completeMention("ask @ap", "api-auth")).toBe("ask @api-auth ");
		expect(completeMention("@", "api-auth")).toBe("@api-auth ");
		expect(completeMention("a @x and @lo", "login")).toBe("a @x and @login ");
	});
});

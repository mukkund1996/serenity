import { describe, expect, test } from "bun:test";
import { checkSessionName, findSessionByName } from "../src/session-name";
import { makeSession } from "../test-support";

describe("findSessionByName", () => {
	test("finds nothing for an unknown name", () => {
		expect(findSessionByName([makeSession()], "other")).toBeUndefined();
		expect(findSessionByName([], undefined)).toBeUndefined();
	});

	test("a live session beats an archived one, whatever the order", () => {
		const old = makeSession({ id: "old", status: "archived", createdAt: 1 });
		const live = makeSession({ id: "live", status: "idle", createdAt: 2 });
		expect(findSessionByName([old, live], "api-auth")?.id).toBe("live");
		expect(findSessionByName([live, old], "api-auth")?.id).toBe("live");
		// Even when the archived one is the newer.
		const newer = makeSession({ id: "new", status: "archived", createdAt: 9 });
		expect(findSessionByName([newer, live], "api-auth")?.id).toBe("live");
	});

	test("an ended session beats an archived one, a live one beats both", () => {
		const archived = makeSession({ id: "a", status: "archived", createdAt: 3 });
		const dead = makeSession({ id: "d", status: "dead", createdAt: 2 });
		const live = makeSession({ id: "l", status: "working", createdAt: 1 });
		expect(findSessionByName([archived, dead], "api-auth")?.id).toBe("d");
		expect(findSessionByName([archived, dead, live], "api-auth")?.id).toBe("l");
	});

	test("among equals, the most recently created", () => {
		const a = makeSession({ id: "a", status: "idle", createdAt: 1 });
		const b = makeSession({ id: "b", status: "idle", createdAt: 2 });
		expect(findSessionByName([a, b], "api-auth")?.id).toBe("b");
		expect(findSessionByName([b, a], "api-auth")?.id).toBe("b");
		const x = makeSession({ id: "x", status: "archived", createdAt: 1 });
		const y = makeSession({ id: "y", status: "archived", createdAt: 2 });
		expect(findSessionByName([x, y], "api-auth")?.id).toBe("y");
	});

	test("falls back to the archived session when none is live", () => {
		const archived = makeSession({ id: "a", status: "archived" });
		expect(findSessionByName([archived], "api-auth")?.id).toBe("a");
	});
});

describe("checkSessionName (ADR 0063)", () => {
	const live = makeSession({ id: "live", name: "api-auth", status: "idle" });
	const check = (raw: string, sessions = [live], self?: string) =>
		checkSessionName(raw, sessions, self);

	test("letters, digits, . _ - and spaces made into -", () => {
		expect(check("  fix login  ")).toEqual({ name: "fix-login" });
		expect(check("v1.2_docs")).toEqual({ name: "v1.2_docs" });
		expect(check("Web-Login")).toEqual({ name: "Web-Login" });
	});

	test("refuses an empty name, other characters, a leading . _ - and more than 40", () => {
		expect(check("   ")).toEqual({ error: "Give the session a name." });
		const rule = { error: "name: letters, digits, . _ - (max 40)" };
		expect(check("fix/login")).toEqual(rule);
		expect(check("über")).toEqual(rule);
		expect(check("-dash")).toEqual(rule);
		expect(check("a".repeat(41))).toEqual(rule);
		expect(check("a".repeat(40))).toEqual({ name: "a".repeat(40) });
	});

	test("refuses every command word, in any case (ADR 0048)", () => {
		for (const word of ["new", "copy", "handover", "move", "Move", "NEW"])
			expect(check(word)).toEqual({
				error: `${word} is reserved for @${word.toLowerCase()} in the master; pick another name`,
			});
		expect(check("move-docs")).toEqual({ name: "move-docs" });
	});

	test("refuses a name a live session has, in any case", () => {
		const error = { error: "a session named api-auth already exists" };
		expect(check("api-auth")).toEqual(error);
		expect(check("API-Auth")).toEqual(error);
	});

	test("a session may keep its name or change its case", () => {
		expect(check("api-auth", [live], "live")).toEqual({ name: "api-auth" });
		expect(check("Api-Auth", [live], "live")).toEqual({ name: "Api-Auth" });
	});

	test("an archived session, or an ended one not pinned, frees its name", () => {
		const archived = makeSession({ name: "old", status: "archived" });
		const ended = makeSession({ name: "gone", status: "dead" });
		const pinned = makeSession({ name: "kept", status: "dead", pinned: true });
		const all = [archived, ended, pinned];
		expect(check("old", all)).toEqual({ name: "old" });
		expect(check("gone", all)).toEqual({ name: "gone" });
		expect(check("kept", all)).toEqual({
			error: "a session named kept already exists",
		});
	});
});

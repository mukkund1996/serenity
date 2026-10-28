import { describe, expect, test } from "bun:test";
import { findSessionByName } from "../src/session-name";
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

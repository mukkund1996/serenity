import { describe, expect, test } from "bun:test";
import type { MasterPermission, SlackItem } from "@serenity/core";
import { makeSession, makeSuggestion } from "@serenity/core/testing";
import { xAction } from "../src/dismiss";

const none = {
	slackItem: null,
	queued: null,
	permission: null,
	session: null,
};
const permission: MasterPermission = {
	id: "p1",
	repo: "/repos/demo",
	toolName: "Bash",
	detail: "npm test",
	at: 1,
};
const slackItem = { id: "m1", author: "Dana" } as SlackItem;

describe("x on the master only dismisses (ADR 0057)", () => {
	test("each NEEDS YOU item kind is dismissed, never cleaned up", () => {
		for (const status of ["waiting", "done", "dead", "idle"] as const) {
			const session = makeSession({ status });
			expect(xAction({ ...none, onMaster: true, session })).toEqual({
				kind: "session",
				session,
			});
		}
		expect(xAction({ ...none, onMaster: true, permission }).kind).toBe(
			"permission",
		);
		expect(xAction({ ...none, onMaster: true, slackItem }).kind).toBe("slack");
		const queued = makeSuggestion({ source: "chat" });
		expect(xAction({ ...none, onMaster: true, queued }).kind).toBe("queued");
	});

	test("nothing selected on the master: x does nothing", () => {
		expect(xAction({ ...none, onMaster: true })).toEqual({ kind: "none" });
	});

	test("on a card, x asks to clean the session up", () => {
		const session = makeSession();
		expect(xAction({ ...none, onMaster: false, session })).toEqual({
			kind: "cleanup",
			session,
		});
		expect(xAction({ ...none, onMaster: false })).toEqual({ kind: "none" });
	});
});

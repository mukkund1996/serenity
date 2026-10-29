import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageContract } from "@serenity/core/testing";
import { createSqliteStorage } from "../src/sqlite";

const dir = mkdtempSync(join(tmpdir(), "sdb-"));
let n = 0;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

storageContract("sqlite", () => createSqliteStorage(join(dir, `t${n++}.db`)));

test("data survives reopening", () => {
	const path = join(dir, "reopen.db");
	const first = createSqliteStorage(path);
	first.events.append({ sessionId: "s1", kind: "Stop", payload: {}, at: 1 });
	first.close();
	const second = createSqliteStorage(path);
	expect(second.events.listForSession("s1", 5)).toHaveLength(1);
	second.close();
});

test("slack dismissals survive reopening", () => {
	const path = join(dir, "dismiss.db");
	const first = createSqliteStorage(path);
	first.slackDismissals.add({ channelId: "C1", ts: "1730000000.1", at: 5 });
	first.close();
	const second = createSqliteStorage(path);
	expect(second.slackDismissals.list()).toEqual([
		{ channelId: "C1", ts: "1730000000.1", at: 5 },
	]);
	second.close();
});

test("older sessions read back with the new fields, category as topic", async () => {
	const { Database } = await import("bun:sqlite");
	const path = join(dir, "old.db");
	const first = createSqliteStorage(path);
	first.close();
	const raw = new Database(path);
	raw.run(
		"INSERT INTO sessions (id, repo, created_at, data) VALUES ('old', '/r', 1, ?)",
		[
			JSON.stringify({
				id: "old",
				repo: "/r",
				name: "legacy",
				status: "idle",
				createdAt: 1,
				category: "backend",
			}),
		],
	);
	raw.close();
	const second = createSqliteStorage(path);
	expect(second.sessions.get("old")).toMatchObject({
		name: "legacy",
		waitingOn: null,
		topic: "backend",
		topicCandidate: null,
	});
	expect(second.sessions.get("old")).not.toHaveProperty("category");
	second.close();
});

test("recovery state survives reopening", () => {
	const path = join(dir, "recovery.db");
	const first = createSqliteStorage(path);
	const usage = {
		session: { usedPercent: 40, resetsAt: 9 },
		week: null,
		at: 3,
	};
	first.recovery.set("usage", usage);
	first.close();
	const second = createSqliteStorage(path);
	expect(second.recovery.get("usage")).toEqual(usage);
	second.close();
});

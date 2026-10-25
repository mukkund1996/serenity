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

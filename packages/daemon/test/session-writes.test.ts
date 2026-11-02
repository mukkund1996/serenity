import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStorage, type PrInfo, type Session } from "@serenity/core";
import { makeSession } from "@serenity/core/testing";
import { Daemon } from "../src/daemon";

const home = mkdtempSync(join(tmpdir(), "swrites-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const pr = { number: 74, state: "OPEN", checks: "running" } as PrInfo;

test("a patch from a copy read before an await keeps what others wrote since", () => {
	const storage = createMemoryStorage();
	const daemon = new Daemon({ home, storage, log: () => {} });
	const change = (
		daemon as unknown as {
			change(s: Session, p: Partial<Session>): Session;
		}
	).change.bind(daemon);
	storage.sessions.put(makeSession({ id: "s1", pr: null }));
	// The observer read the session, then awaited tmux…
	const stale = storage.sessions.get("s1") as Session;
	// …while the PR watcher wrote the PR it had just read…
	change(stale, { pr, prError: null });
	// …and then the observer saved its own patch from its old copy.
	const next = change(stale, { summary: "working on it" });
	expect(next).toMatchObject({ pr: { number: 74 }, summary: "working on it" });
	expect(storage.sessions.get("s1")?.pr?.number).toBe(74);
});

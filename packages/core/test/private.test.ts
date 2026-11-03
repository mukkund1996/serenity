import { afterAll, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDir, securePrivateState } from "../src/private";

const dir = mkdtempSync(join(tmpdir(), "sprv-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const mode = (path: string) => statSync(path).mode & 0o777;

test("ensurePrivateDir creates the folder 0700 and tightens an existing one", () => {
	const fresh = join(dir, "fresh", "home");
	ensurePrivateDir(fresh);
	expect(mode(fresh)).toBe(0o700);
	const old = join(dir, "old");
	mkdirSync(old, { mode: 0o755 });
	chmodSync(old, 0o755);
	ensurePrivateDir(old);
	expect(mode(old)).toBe(0o700);
});

test("securePrivateState tightens what an older version left readable", () => {
	const home = join(dir, "state");
	mkdirSync(join(home, "handovers", "repo"), { recursive: true });
	mkdirSync(join(home, "crash-reports"));
	const files = [
		"serenity.db",
		"serenity.db-wal",
		"daemon.log",
		"handovers/repo/doc.md",
		"crash-reports/report.md",
	];
	for (const f of files) writeFileSync(join(home, f), "x", { mode: 0o644 });
	writeFileSync(join(home, "claude-hooks.json"), "{}", { mode: 0o644 });
	for (const d of ["", "handovers", "handovers/repo", "crash-reports"])
		chmodSync(join(home, d), 0o755);

	securePrivateState(home);

	expect(mode(home)).toBe(0o700);
	for (const d of ["handovers", "handovers/repo", "crash-reports"])
		expect(mode(join(home, d))).toBe(0o700);
	for (const f of files) expect(mode(join(home, f))).toBe(0o600);
	// Files it does not name keep their mode; the folder already guards them.
	expect(mode(join(home, "claude-hooks.json"))).toBe(0o644);
});

test("securePrivateState is fine with a home that has nothing in it yet", () => {
	const home = join(dir, "empty");
	securePrivateState(home);
	expect(mode(home)).toBe(0o700);
});

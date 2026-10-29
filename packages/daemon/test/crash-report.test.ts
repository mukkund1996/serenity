import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CrashInfo,
	CrashReporter,
	crashSignature,
	type IssueTracker,
	recordCrash,
	scrub,
	takeCrash,
} from "../src/crash-report";

const dir = mkdtempSync(join(tmpdir(), "scrash-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const HOME = "/Users/alice";

function crash(overrides: Partial<CrashInfo> = {}): CrashInfo {
	return {
		name: "TypeError",
		message: "session 3f2a9c1e-1111-4222-8333-944455556666 has no pane %12",
		stack: [
			"TypeError: session has no pane",
			"    at requireLivePane (/Users/alice/projects/serenity/packages/daemon/src/daemon.ts:712:9)",
			"    at attach (/Users/alice/projects/serenity/packages/daemon/src/daemon.ts:820:20)",
			"    at processTicksAndRejections (native:7:39)",
		].join("\n"),
		code: 70,
		signal: null,
		...overrides,
	};
}

test("scrub removes tokens, emails and paths, keeping serenity's source paths", () => {
	const text = [
		"token ghp_abcdefghijklmnopqrstuvwxyz0123 and xoxb-1234-5678-abcdefgh",
		"Authorization: Bearer abc.def.ghijklmnopqrstu",
		'{"api_key": "s3cr3t-value"} password=hunter22',
		"mail alice@example.com about https://me:pw@host.dev/x",
		"cwd /Users/alice/projects/secret-repo and ~/work/other",
		"at fn (/Users/alice/projects/serenity/packages/daemon/src/daemon.ts:1:2)",
		"see https://github.com/acme/app/pull/4 and /$bunfs/root/serenity",
		"user alice ran it",
	].join("\n");
	const out = scrub(text, HOME, "alice");
	expect(out).not.toContain("ghp_");
	expect(out).not.toContain("xoxb-");
	expect(out).not.toContain("abc.def");
	expect(out).not.toContain("s3cr3t");
	expect(out).not.toContain("hunter22");
	expect(out).not.toContain("example.com");
	expect(out).not.toContain(":pw@");
	expect(out).not.toContain("secret-repo");
	expect(out).not.toContain("work/other");
	expect(out).not.toContain("alice");
	expect(out).toContain("packages/daemon/src/daemon.ts:1:2");
	expect(out).toContain("https://github.com/acme/app/pull/4");
	expect(out).toContain("/$bunfs/root/serenity");
});

test("the signature ignores ids, numbers, line numbers and where serenity lives", () => {
	const a = crashSignature(crash());
	const b = crashSignature(
		crash({
			message: "session 00000000-aaaa-4bbb-8ccc-dddddddddddd has no pane %3",
			stack: crash()
				.stack?.replaceAll("/Users/alice/projects", "/home/bob/src")
				.replace(":712:9", ":730:9"),
		}),
	);
	expect(b).toBe(a);
	expect(crashSignature(crash({ name: "RangeError" }))).not.toBe(a);
	expect(
		crashSignature(
			crash({ stack: crash().stack?.replace("attach (", "detach (") }),
		),
	).not.toBe(a);
});

test("a worker's recorded crash is read once", () => {
	const path = join(dir, "crash.json");
	recordCrash(path, new RangeError("boom"));
	expect(takeCrash(path)).toMatchObject({
		name: "RangeError",
		message: "boom",
	});
	expect(takeCrash(path)).toBeNull();
});

class FakeTracker implements IssueTracker {
	issues: { number: number; title: string; body: string; open: boolean }[] = [];
	comments: { issue: number; body: string }[] = [];
	async findOpenIssue(needle: string) {
		return (
			this.issues.find((i) => i.open && i.title.includes(needle))?.number ??
			null
		);
	}
	async createIssue(title: string, body: string) {
		const number = this.issues.length + 1;
		this.issues.push({ number, title, body, open: true });
		return number;
	}
	async commentIssue(issue: number, body: string) {
		this.comments.push({ issue, body });
	}
}

const env = {
	build: "0.6.0+test",
	os: "darwin 25.5.0 arm64",
	runtime: "Bun 1.4.4",
};

function reporter(
	name: string,
	tracker: IssueTracker,
	clock: { t: number },
	enabled = true,
) {
	return new CrashReporter({
		dir: join(dir, name),
		enabled,
		tracker,
		env,
		now: () => clock.t,
		policy: { perSignatureMs: 60_000, dailyLimit: 3 },
	});
}

test("off: the report stays on disk and nothing reaches GitHub", async () => {
	const tracker = new FakeTracker();
	const r = reporter("off", tracker, { t: 1000 }, false);
	expect(await r.report(crash(), "log line")).toBe("local-only");
	expect(tracker.issues).toHaveLength(0);
	const files = readdirSync(join(dir, "off")).filter((f) => f.endsWith(".md"));
	expect(files).toHaveLength(1);
	expect(readFileSync(join(dir, "off", files[0] as string), "utf8")).toContain(
		"Crash: TypeError",
	);
});

test("one issue per signature; repeats are rate-limited, then comment with the count", async () => {
	const tracker = new FakeTracker();
	const clock = { t: 1_000_000 };
	const r = reporter("dedupe", tracker, clock);
	expect(await r.report(crash(), "first log")).toBe("filed");
	expect(await r.report(crash(), "again")).toBe("rate-limited");
	expect(await r.report(crash(), "again")).toBe("rate-limited");
	clock.t += 61_000;
	expect(await r.report(crash(), "later log")).toBe("commented");
	expect(tracker.issues).toHaveLength(1);
	const issue = tracker.issues[0];
	expect(issue?.title).toMatch(
		/^Crash: TypeError: session <id> has no pane %N \(sig:[0-9a-f]{12}\)$/,
	);
	expect(issue?.body).toContain("0.6.0+test");
	expect(issue?.body).toContain("darwin 25.5.0 arm64");
	expect(issue?.body).toContain("packages/daemon/src/daemon.ts");
	expect(issue?.body).not.toContain("/Users/alice");
	expect(tracker.comments).toEqual([
		{ issue: 1, body: expect.stringContaining("2 more occurrences") },
	]);
});

test("a closed issue's crash files a new one; another machine comments on the open one", async () => {
	const tracker = new FakeTracker();
	const clock = { t: 5_000_000 };
	expect(await reporter("m1", tracker, clock).report(crash(), "")).toBe(
		"filed",
	);
	// Another machine, with no local state, finds the open issue.
	expect(await reporter("m2", tracker, clock).report(crash(), "")).toBe(
		"commented",
	);
	(tracker.issues[0] as { open: boolean }).open = false;
	expect(await reporter("m3", tracker, clock).report(crash(), "")).toBe(
		"filed",
	);
	expect(tracker.issues).toHaveLength(2);
});

test("the daily limit caps writes across signatures", async () => {
	const tracker = new FakeTracker();
	const r = reporter("daily", tracker, { t: 9_000_000 });
	const outcomes = [];
	for (const name of ["A", "B", "C", "D"])
		outcomes.push(await r.report(crash({ name }), ""));
	expect(outcomes).toEqual(["filed", "filed", "filed", "rate-limited"]);
});

test("a failing gh is reported as failed and still rate-limited", async () => {
	const tracker = new FakeTracker();
	tracker.findOpenIssue = async () => {
		throw new Error("gh not logged in");
	};
	const r = reporter("fail", tracker, { t: 1 });
	expect(await r.report(crash(), "")).toBe("failed");
	expect(await r.report(crash(), "")).toBe("rate-limited");
});

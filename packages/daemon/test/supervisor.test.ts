import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireLock,
	releaseLock,
	Supervisor,
	type SupervisorHost,
	type WorkerExit,
} from "../src/supervisor";

const dir = mkdtempSync(join(tmpdir(), "ssup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const POLICY = {
	backoffMs: 100,
	maxBackoffMs: 350,
	crashLimit: 4,
	crashWindowMs: 10_000,
};

/** Workers that exit as scripted, on a fake clock where sleeping advances time. */
function host(exits: WorkerExit[]) {
	let t = 0;
	let pid = 100;
	const sleeps: number[] = [];
	const crashes: WorkerExit[] = [];
	const lines: string[] = [];
	const h: SupervisorHost = {
		spawnWorker: () => {
			const exit = exits.shift() ?? { code: 0, signal: null };
			return {
				pid: pid++,
				exited: Promise.resolve(exit),
				kill: () => {},
			};
		},
		onCrash: async (exit) => {
			crashes.push(exit);
		},
		now: () => t,
		sleep: async (ms) => {
			sleeps.push(ms);
			t += ms;
		},
		log: (line) => lines.push(line),
	};
	return { h, sleeps, crashes, lines, advance: (ms: number) => (t += ms) };
}

test("a crashed worker restarts with doubling backoff; a clean exit ends it", async () => {
	const crash = { code: 70, signal: null };
	const killed = { code: null, signal: "SIGKILL" };
	const { h, sleeps, crashes } = host([
		crash,
		killed,
		crash,
		{ code: 0, signal: null },
	]);
	expect(await new Supervisor(h, POLICY).run()).toBe(0);
	expect(sleeps).toEqual([100, 200, 350]);
	expect(crashes).toEqual([crash, killed, crash]);
});

test("too many crashes in the window is a crash loop: give up with 1", async () => {
	const crash = { code: 70, signal: null };
	const { h, lines } = host([crash, crash, crash, crash, crash]);
	expect(await new Supervisor(h, POLICY).run()).toBe(1);
	expect(lines.at(-1)).toContain("4 crashes");
});

test("crashes older than the window no longer count", async () => {
	const crash = { code: 70, signal: null };
	const { h, sleeps } = host([crash, crash, crash, crash, crash, crash]);
	const slow = { ...POLICY, crashWindowMs: 250 };
	// Each wait moves the clock, so old crashes leave the window.
	expect(await new Supervisor(h, slow).run()).toBe(0);
	expect(sleeps.every((ms) => ms <= 200)).toBe(true);
});

test("stop ends supervision without a restart", async () => {
	let finish: (exit: WorkerExit) => void = () => {};
	let spawned = 0;
	const killed: string[] = [];
	const supervisor = new Supervisor(
		{
			spawnWorker: () => {
				spawned++;
				return {
					pid: 1,
					exited: new Promise((resolve) => {
						finish = resolve;
					}),
					kill: (signal) => {
						killed.push(signal);
						finish({ code: null, signal });
					},
				};
			},
			onCrash: async () => {},
			now: () => 0,
			sleep: async () => {},
			log: () => {},
		},
		POLICY,
	);
	const done = supervisor.run();
	supervisor.stop();
	expect(await done).toBe(0);
	expect(killed).toEqual(["SIGTERM"]);
	expect(spawned).toBe(1);
});

test("the lock admits one supervisor and is taken over when stale", () => {
	const path = join(dir, "daemon.lock");
	expect(acquireLock(path, process.pid)).toBeNull();
	// Another live process (this test's parent) cannot take it.
	expect(acquireLock(path, process.ppid)).toBe(process.pid);
	releaseLock(path, process.ppid);
	expect(readFileSync(path, "utf8")).toBe(String(process.pid));
	releaseLock(path, process.pid);
	// A lock left by a dead pid is stale.
	writeFileSync(path, "999999");
	expect(acquireLock(path, process.pid)).toBeNull();
	releaseLock(path, process.pid);
});

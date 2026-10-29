import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, release } from "node:os";
import {
	BUILD_ID,
	crashReportsDir,
	daemonCrashPath,
	daemonLockPath,
	daemonLogPath,
	loadConfig,
	selfCommand,
} from "@serenity/core";
import {
	type CrashInfo,
	CrashReporter,
	type IssueTracker,
	tailFile,
	takeCrash,
} from "./crash-report";
import { Gh } from "./gh";

/** How a worker ended. */
export interface WorkerExit {
	code: number | null;
	signal: string | null;
}

export interface Worker {
	pid: number;
	exited: Promise<WorkerExit>;
	kill(signal: NodeJS.Signals): void;
}

export interface SupervisorPolicy {
	/** Wait before the first restart; doubles with each crash in the window. */
	backoffMs: number;
	maxBackoffMs: number;
	/** This many crashes within `crashWindowMs` is a crash loop: give up. */
	crashLimit: number;
	crashWindowMs: number;
}

export const DEFAULT_SUPERVISOR_POLICY: SupervisorPolicy = {
	backoffMs: 500,
	maxBackoffMs: 30_000,
	crashLimit: 5,
	crashWindowMs: 5 * 60_000,
};

export interface SupervisorHost {
	spawnWorker(): Worker;
	/** Reports a crash; restarts do not wait for it. */
	onCrash(exit: WorkerExit): Promise<void>;
	now(): number;
	sleep(ms: number): Promise<void>;
	log(line: string): void;
}

const describe = (exit: WorkerExit) =>
	exit.signal
		? `was killed by ${exit.signal}`
		: `exited with code ${exit.code}`;

/**
 * Runs the daemon worker and restarts it when it crashes (ADR 0044): after a
 * backoff that doubles per crash, until `crashLimit` crashes fall within the
 * window. A clean exit (code 0: `serenity stop`, a new build taking over)
 * ends supervision.
 */
export class Supervisor {
	private worker: Worker | null = null;
	private stopping = false;
	private readonly reports: Promise<void>[] = [];
	private wake: (() => void) | null = null;

	constructor(
		private readonly host: SupervisorHost,
		private readonly policy = DEFAULT_SUPERVISOR_POLICY,
	) {}

	/** Resolves with the supervisor's exit code. */
	async run(): Promise<number> {
		let crashes: number[] = [];
		try {
			while (!this.stopping) {
				this.worker = this.host.spawnWorker();
				this.host.log(`supervisor: started worker pid ${this.worker.pid}`);
				const exit = await this.worker.exited;
				this.worker = null;
				if (this.stopping) break;
				if (exit.code === 0) {
					this.host.log("supervisor: worker exited cleanly");
					break;
				}
				const at = this.host.now();
				crashes = [
					...crashes.filter((t) => at - t < this.policy.crashWindowMs),
					at,
				];
				this.reports.push(
					this.host
						.onCrash(exit)
						.catch((e: Error) =>
							this.host.log(`supervisor: crash report: ${e.message}`),
						),
				);
				if (crashes.length >= this.policy.crashLimit) {
					this.host.log(
						`supervisor: worker ${describe(exit)}; ${crashes.length} crashes in ${Math.round(this.policy.crashWindowMs / 1000)}s, giving up`,
					);
					return 1;
				}
				const delay = Math.min(
					this.policy.backoffMs * 2 ** (crashes.length - 1),
					this.policy.maxBackoffMs,
				);
				this.host.log(
					`supervisor: worker ${describe(exit)}; restarting in ${delay}ms (crash ${crashes.length} of ${this.policy.crashLimit})`,
				);
				await Promise.race([
					this.host.sleep(delay),
					new Promise<void>((resolve) => {
						this.wake = resolve;
					}),
				]);
				this.wake = null;
			}
			return 0;
		} finally {
			await Promise.all(this.reports);
		}
	}

	/** Stops the worker (SIGTERM, so it shuts down cleanly) and supervision. */
	stop(): void {
		this.stopping = true;
		this.worker?.kill("SIGTERM");
		this.wake?.();
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Takes the home's supervisor lock, or returns the pid that holds it. A lock
 * whose pid is gone is stale and taken over.
 */
export function acquireLock(path: string, pid = process.pid): number | null {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(path, String(pid), { flag: "wx" });
			return null;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let holder = 0;
		try {
			holder = Number(readFileSync(path, "utf8").trim());
		} catch {}
		if (holder && holder !== pid && alive(holder)) return holder;
		rmSync(path, { force: true });
	}
	return -1;
}

/** Removes the lock if it is still ours. */
export function releaseLock(path: string, pid = process.pid): void {
	try {
		if (Number(readFileSync(path, "utf8").trim()) === pid) rmSync(path);
	} catch {}
}

const envNumber = (name: string, fallback: number) =>
	process.env[name] ? Number(process.env[name]) : fallback;

function ghTracker(home: string, repo: string): IssueTracker {
	const gh = new Gh();
	return {
		findOpenIssue: (needle) => gh.findOpenIssue(home, repo, needle),
		createIssue: (title, body) => gh.createIssue(home, repo, title, body),
		commentIssue: (issue, body) => gh.commentIssue(home, repo, issue, body),
	};
}

/**
 * `serenity daemon`: supervises `serenity daemon --worker` (ADR 0044). One
 * supervisor per home: a second one leaves while the first is alive, even
 * between restarts; whoever asks a daemon to go waits for its lock to clear.
 */
export async function runSupervisor(home: string): Promise<number> {
	const log = (line: string) =>
		console.log(`${new Date().toISOString()} ${line}`);
	const lock = daemonLockPath(home);
	const holder = acquireLock(lock);
	if (holder !== null) {
		log(`supervisor: pid ${holder} already supervises this home`);
		return 0;
	}

	const config = loadConfig();
	const reporter = new CrashReporter({
		dir: crashReportsDir(home),
		enabled: config.crashReports.enabled,
		tracker: ghTracker(home, config.crashReports.repo),
		env: {
			build: BUILD_ID,
			os: `${process.platform} ${release()} ${arch()}`,
			runtime: `Bun ${Bun.version}`,
		},
		log,
	});
	const self = selfCommand();
	const supervisor = new Supervisor(
		{
			spawnWorker: () => {
				const proc = Bun.spawn([...self, "daemon", "--worker"], {
					stdio: ["ignore", "inherit", "inherit"],
					env: { ...process.env, SERENITY_HOME: home },
				});
				return {
					pid: proc.pid,
					exited: proc.exited.then(() => ({
						code: proc.exitCode,
						signal: proc.signalCode === null ? null : String(proc.signalCode),
					})),
					kill: (signal) => proc.kill(signal),
				};
			},
			onCrash: async (exit) => {
				const recorded = takeCrash(daemonCrashPath(home));
				// Killed from outside with nothing recorded (kill -9, OOM): restart, no issue.
				if (!recorded && exit.signal) return;
				const info: CrashInfo = {
					...(recorded ?? {
						name: "Exit",
						message: `serenityd exited with code ${exit.code}`,
						stack: null,
					}),
					...exit,
				};
				await reporter.report(info, tailFile(daemonLogPath(home)));
			},
			now: Date.now,
			sleep: (ms) => Bun.sleep(ms),
			log,
		},
		{
			...DEFAULT_SUPERVISOR_POLICY,
			backoffMs: envNumber(
				"SERENITY_SUPERVISOR_BACKOFF_MS",
				DEFAULT_SUPERVISOR_POLICY.backoffMs,
			),
			crashLimit: envNumber(
				"SERENITY_SUPERVISOR_CRASH_LIMIT",
				DEFAULT_SUPERVISOR_POLICY.crashLimit,
			),
		},
	);
	const stop = () => supervisor.stop();
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	try {
		return await supervisor.run();
	} finally {
		releaseLock(lock);
	}
}

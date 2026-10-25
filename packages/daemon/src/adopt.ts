import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	type FSWatcher,
	fstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
	watch,
} from "node:fs";
import { join } from "node:path";
import {
	adoptedName,
	type ClaudeProcess,
	claudeConfigDir,
	type ImportCandidate,
	parseClaudeProcess,
	permissionPrompt,
	readTranscriptTail,
	reduceObserved,
	type Session,
	type SessionStatus,
	type Storage,
	type TranscriptTail,
	transcriptPathFor,
} from "@serenity/core";
import { commonDir, currentBranch } from "./git";
import type { Tmux } from "./tmux";

export interface AdoptHost {
	storage: Storage;
	tmux: Tmux;
	now(): number;
	/** Saves a patch and lets the master react (summaries, suggestions). */
	change(session: Session, patch: Partial<Session>): Session;
	broadcast(repo: string): void;
	markEnded(session: Session): void;
	/** Binds Ctrl+g so an adopted pane can return to the map. */
	bindDetachKey(): Promise<void>;
	log(line: string): void;
}

/** Enough of a transcript to find its title, last prompt and last reply. */
const TAIL_BYTES = 512 * 1024;
/** Settles a burst of session-file writes into one sweep. */
const SETTLE_MS = 200;
/** Catches anything the file watcher missed (it can, on some filesystems). */
const SWEEP_MS = 30_000;

const live = (s: Session) => s.status !== "dead" && s.status !== "archived";

/**
 * Finds claude sessions the user started in their own tmux windows, adopts
 * them onto the map, and keeps the adopted ones current from Claude's own
 * session files and transcripts (ADR 0016). No hooks, no restart.
 */
export class ClaudeObserver {
	private watcher: FSWatcher | null = null;
	private sweepTimer: ReturnType<typeof setInterval> | null = null;
	private settleTimer: ReturnType<typeof setTimeout> | null = null;
	/** session id → the last Claude state applied, so unchanged files are skipped. */
	private readonly seen = new Map<string, string>();
	private readonly repoDirs = new Map<string, string | null>();

	constructor(
		private readonly host: AdoptHost,
		private readonly configDir = claudeConfigDir(),
	) {}

	private get sessionsDir(): string {
		return join(this.configDir, "sessions");
	}

	start(): void {
		this.watchSessions();
		this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_MS);
		this.sweepTimer.unref?.();
		void this.sweep();
	}

	/** Watches Claude's session files; the folder may only appear later. */
	private watchSessions(): void {
		if (this.watcher || !existsSync(this.sessionsDir)) return;
		try {
			this.watcher = watch(this.sessionsDir, () => this.settle());
		} catch (error) {
			this.host.log(`cannot watch ${this.sessionsDir}: ${String(error)}`);
		}
	}

	stop(): void {
		this.watcher?.close();
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		if (this.settleTimer) clearTimeout(this.settleTimer);
	}

	private settle(): void {
		if (this.settleTimer) clearTimeout(this.settleTimer);
		this.settleTimer = setTimeout(() => void this.sweep(), SETTLE_MS);
	}

	/** Every live interactive claude running in a tmux pane. */
	processes(): ClaudeProcess[] {
		let files: string[];
		try {
			files = readdirSync(this.sessionsDir).filter((f) => f.endsWith(".json"));
		} catch {
			return [];
		}
		const found: ClaudeProcess[] = [];
		for (const file of files) {
			try {
				const proc = parseClaudeProcess(
					JSON.parse(readFileSync(join(this.sessionsDir, file), "utf8")),
				);
				if (proc && alive(proc.pid)) found.push(proc);
			} catch {}
		}
		return found;
	}

	/** Claudes in tmux, in this repo or one of its worktrees, not on the map yet. */
	async candidates(repo: string): Promise<ImportCandidate[]> {
		const tracked = this.host.storage.sessions.listAll().filter(live);
		const panes = new Set(tracked.map((s) => s.tmuxPane));
		const ids = new Set(tracked.map((s) => s.claudeSessionId));
		const taken = new Set(
			this.host.storage.sessions
				.listByRepo(repo)
				.filter(live)
				.map((s) => s.name),
		);
		const found: ImportCandidate[] = [];
		for (const proc of this.processes()) {
			if (panes.has(proc.pane) || ids.has(proc.sessionId)) continue;
			if (!(await this.inRepo(proc.cwd, repo))) continue;
			if (!(await this.host.tmux.paneExists(proc.pane))) continue;
			const where = await this.host.tmux.describePane(proc.pane);
			const tail = this.tail(proc);
			const name = adoptedName(
				[where.windowName, tail.title, proc.name],
				taken,
			);
			taken.add(name);
			found.push({
				claudeSessionId: proc.sessionId,
				pid: proc.pid,
				tmuxPane: proc.pane,
				location: `${where.session}:${where.window} ${where.windowName}`,
				name,
				title: tail.title,
				lastPrompt: tail.lastPrompt,
				cwd: proc.cwd,
				branch:
					tail.branch ?? (await currentBranch(proc.cwd).catch(() => null)),
				status: statusOf(proc),
			});
		}
		return found;
	}

	/** Puts the chosen candidates on the map and starts observing them. */
	async adopt(repo: string, claudeSessionIds: string[]): Promise<Session[]> {
		const wanted = new Set(claudeSessionIds);
		const chosen = (await this.candidates(repo)).filter((c) =>
			wanted.has(c.claudeSessionId),
		);
		if (chosen.length) await this.host.bindDetachKey();
		this.watchSessions();
		const adopted: Session[] = [];
		for (const c of chosen) {
			const at = this.host.now();
			const session: Session = {
				id: randomUUID(),
				repo,
				name: c.name,
				topic: null,
				cwd: c.cwd,
				worktree: null,
				branch: c.branch,
				ownsBranch: false,
				pr: null,
				prError: null,
				tmuxPane: c.tmuxPane,
				origin: "adopted",
				tracking: "observed",
				claudePid: c.pid,
				status: "idle",
				summary: null,
				ask: null,
				waitingOn: null,
				topicCandidate: null,
				lastPrompt: null,
				lastAssistantMessage: null,
				transcriptPath: transcriptPathFor(
					this.configDir,
					c.cwd,
					c.claudeSessionId,
				),
				claudeSessionId: c.claudeSessionId,
				watched: false,
				createdAt: at,
				updatedAt: at,
			};
			this.host.storage.sessions.put(session);
			await this.host.tmux.setPaneOption(
				c.tmuxPane,
				"@serenity_session",
				session.id,
			);
			this.host.log(`adopted ${c.name} (${c.location}, pid ${c.pid})`);
			adopted.push(session);
		}
		await this.sweep();
		if (chosen.length) this.host.broadcast(repo);
		return adopted.map((s) => this.host.storage.sessions.get(s.id) ?? s);
	}

	/** Brings every observed session up to date; ends those whose claude is gone. */
	async sweep(): Promise<void> {
		const observed = this.host.storage.sessions
			.listAll()
			.filter((s) => s.tracking === "observed" && live(s));
		if (!observed.length) return;
		const byPid = new Map(this.processes().map((p) => [p.pid, p]));
		for (const session of observed) {
			const proc = session.claudePid ? byPid.get(session.claudePid) : undefined;
			if (!proc || proc.sessionId !== session.claudeSessionId) {
				this.seen.delete(session.id);
				if (session.tmuxPane)
					await this.host.tmux
						.unsetPaneOption(session.tmuxPane, "@serenity_session")
						.catch(() => {});
				this.host.log(`${session.name} ended (claude exited)`);
				this.host.markEnded(session);
				continue;
			}
			// A quick turn can go busy → idle between two reads; the transcript grows anyway.
			const key = `${proc.status}|${proc.waitingFor}|${fileSize(session.transcriptPath)}`;
			if (this.seen.get(session.id) === key) continue;
			this.seen.set(session.id, key);
			const permission =
				proc.status === "waiting" && session.tmuxPane
					? permissionPrompt(
							await this.host.tmux
								.capturePane(session.tmuxPane)
								.catch(() => ""),
						)
					: null;
			const tail = this.tail(proc, session.transcriptPath);
			const patch = reduceObserved(session, {
				process: proc,
				tail,
				permission,
			});
			if (Object.keys(patch).length) {
				this.host.change(session, patch);
				this.host.broadcast(session.repo);
			}
		}
	}

	/** Forget what was applied, e.g. after a session is restarted under hooks. */
	forget(sessionId: string): void {
		this.seen.delete(sessionId);
	}

	private tail(proc: ClaudeProcess, path?: string | null): TranscriptTail {
		const file =
			path ?? transcriptPathFor(this.configDir, proc.cwd, proc.sessionId);
		return readTranscriptTail(readEnd(file, TAIL_BYTES));
	}

	private async inRepo(cwd: string, repo: string): Promise<boolean> {
		if (!this.repoDirs.has(repo))
			this.repoDirs.set(repo, await commonDir(repo));
		const mine = this.repoDirs.get(repo);
		return !!mine && (await commonDir(cwd)) === mine;
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

function fileSize(path: string | null): number {
	try {
		return path ? statSync(path).size : 0;
	} catch {
		return 0;
	}
}

function statusOf(proc: ClaudeProcess): SessionStatus {
	if (proc.status === "busy") return "working";
	if (proc.status === "waiting" || proc.status === "needs_trust")
		return "waiting";
	return "idle";
}

/** The last `bytes` of a file as text; "" when it cannot be read. */
function readEnd(path: string, bytes: number): string {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const length = Math.min(size, bytes);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		return buffer.toString("utf8");
	} catch {
		return "";
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

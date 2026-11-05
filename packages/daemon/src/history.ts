import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	adoptedName,
	type HistoryFilter,
	type HistoryResult,
	type HistorySession,
	inWindow,
	isImportable,
	parseRunningClaude,
	type RunningClaude,
	readTranscriptHead,
	readTranscriptTail,
	type Session,
	type Storage,
	underDir,
} from "@serenity/core";
import { commonDir } from "./git";

/** Enough of a transcript's start for its cwd, branch and first prompt. */
const HEAD_BYTES = 64 * 1024;
/** Enough of its end for the title and last prompt. */
const TAIL_BYTES = 256 * 1024;

export interface HistoryHost {
	storage: Storage;
	now(): number;
	log(line: string): void;
}

/** What one transcript file says, cached by its size and mtime. */
interface Scanned {
	key: string;
	entry: Omit<HistorySession, "repo" | "runningPid" | "name"> | null;
}

/**
 * Past Claude Code sessions (ADR 0064): lists the conversations in
 * `<config>/projects`, grouped by the repo they ran in, and puts the chosen
 * ones on their maps, ended until Enter resumes them. Read-only on Claude's
 * folder: it never writes, moves or deletes a transcript.
 */
export class ClaudeHistory {
	private readonly files = new Map<string, Scanned>();
	/** cwd → its main checkout, or null when it is not in a git repo. */
	private readonly repos = new Map<string, string | null>();

	constructor(
		private readonly host: HistoryHost,
		private readonly configDir: string,
	) {}

	/** Every running interactive claude, in tmux or not, by conversation id. */
	running(): Map<string, RunningClaude> {
		const found = new Map<string, RunningClaude>();
		const dir = join(this.configDir, "sessions");
		let names: string[];
		try {
			names = readdirSync(dir).filter((f) => f.endsWith(".json"));
		} catch {
			return found;
		}
		for (const name of names) {
			try {
				const proc = parseRunningClaude(
					JSON.parse(readFileSync(join(dir, name), "utf8")),
				);
				if (proc && alive(proc.pid)) found.set(proc.sessionId, proc);
			} catch {}
		}
		return found;
	}

	/**
	 * The past sessions matching `filter` that no map has yet. Left out: ones
	 * serenity knows (any session, archived too), ones running in tmux (`I`
	 * adopts those in place), ones outside a git repo, and ones whose folder
	 * is gone, which are counted.
	 */
	async discover(filter: HistoryFilter = {}): Promise<HistoryResult> {
		const known = new Set(
			this.host.storage.sessions
				.listAll()
				.map((s) => s.claudeSessionId)
				.filter((id): id is string => !!id),
		);
		const running = this.running();
		const only = filter.repo ? await this.repoOf(filter.repo) : null;
		if (filter.repo && !only) return { sessions: [], gone: 0 };
		const taken = new Map<string, Set<string>>();
		const sessions: HistorySession[] = [];
		let gone = 0;
		for (const entry of this.scan()) {
			if (known.has(entry.claudeSessionId)) continue;
			const proc = running.get(entry.claudeSessionId);
			if (proc?.inTmux) continue;
			if (!inWindow(entry, filter.since, filter.until)) continue;
			if (filter.dir && !underDir(entry.cwd, filter.dir)) continue;
			if (!existsSync(entry.cwd)) {
				gone++;
				continue;
			}
			const repo = await this.repoOf(entry.cwd);
			if (!repo || (only && repo !== only)) continue;
			const names = taken.get(repo) ?? this.liveNames(repo);
			taken.set(repo, names);
			const name = adoptedName([entry.title, entry.firstPrompt], names);
			names.add(name);
			sessions.push({ ...entry, repo, runningPid: proc?.pid ?? null, name });
		}
		sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
		return { sessions, gone };
	}

	/**
	 * Puts the chosen past sessions on their repos' maps: ended, with
	 * `origin: "imported"`, so nothing runs until Enter resumes one. `repo`,
	 * the map asking, keeps its own key for its repo.
	 */
	async import(claudeSessionIds: string[], repo?: string): Promise<Session[]> {
		const wanted = new Set(claudeSessionIds);
		const { sessions } = await this.discover();
		const mine = repo ? await this.repoOf(repo) : null;
		const imported: Session[] = [];
		for (const c of sessions.filter((s) => wanted.has(s.claudeSessionId))) {
			const key = repo && mine === c.repo ? repo : c.repo;
			// Named again against this map, in case the key differs from c.repo.
			const name = adoptedName([c.title, c.firstPrompt], this.liveNames(key));
			const at = this.host.now();
			const session: Session = {
				id: randomUUID(),
				repo: key,
				name,
				topic: null,
				cwd: c.cwd,
				worktree: null,
				branch: c.branch,
				ownsBranch: false,
				base: null,
				pr: null,
				prError: null,
				tmuxPane: null,
				origin: "imported",
				tracking: "hooks",
				claudePid: null,
				status: "dead",
				summary: null,
				ask: null,
				waitingOn: null,
				waitingSince: null,
				topicCandidate: null,
				topicHeld: null,
				lastPrompt: c.lastPrompt ?? c.firstPrompt,
				lastAssistantMessage: null,
				subagents: [],
				transcriptPath: null,
				claudeSessionId: c.claudeSessionId,
				watched: false,
				pinned: false,
				exitNote: null,
				dismissedAt: null,
				parentId: null,
				createdAt: at,
				updatedAt: at,
			};
			this.host.storage.sessions.put(session);
			this.host.log(
				`imported ${name} (${c.claudeSessionId}) from ${c.cwd} into ${key}`,
			);
			imported.push(session);
		}
		return imported;
	}

	/** Names on the repo's map that a new one must not take. */
	private liveNames(repo: string): Set<string> {
		return new Set(
			this.host.storage.sessions
				.listByRepo(repo)
				.filter((s) => s.status !== "archived")
				// Names clash in any case (ADR 0063); adoptedName's are lower case.
				.map((s) => s.name.toLowerCase()),
		);
	}

	/** The main checkout of the repo `dir` is in; null outside git or in a bare repo. */
	private async repoOf(dir: string): Promise<string | null> {
		const cached = this.repos.get(dir);
		if (cached !== undefined) return cached;
		let real = dir;
		try {
			real = realpathSync(dir);
		} catch {}
		const common = await commonDir(real).catch(() => null);
		const repo = common && basename(common) === ".git" ? dirname(common) : null;
		this.repos.set(dir, repo);
		return repo;
	}

	/** Every importable transcript, read once per change of size or mtime. */
	private scan(): NonNullable<Scanned["entry"]>[] {
		const root = join(this.configDir, "projects");
		let projects: string[];
		try {
			projects = readdirSync(root);
		} catch {
			return [];
		}
		const out: NonNullable<Scanned["entry"]>[] = [];
		const seen = new Set<string>();
		for (const project of projects) {
			let names: string[];
			try {
				names = readdirSync(join(root, project)).filter((f) =>
					f.endsWith(".jsonl"),
				);
			} catch {
				continue;
			}
			for (const name of names) {
				const path = join(root, project, name);
				seen.add(path);
				const entry = this.read(path);
				if (entry) out.push(entry);
			}
		}
		for (const path of this.files.keys())
			if (!seen.has(path)) this.files.delete(path);
		return out;
	}

	private read(path: string): Scanned["entry"] {
		let size: number;
		let mtime: number;
		try {
			const st = statSync(path);
			size = st.size;
			mtime = st.mtimeMs;
		} catch {
			return null;
		}
		const key = `${size}:${mtime}`;
		const cached = this.files.get(path);
		if (cached?.key === key) return cached.entry;
		const head = readTranscriptHead(readRange(path, 0, HEAD_BYTES));
		const tail = readTranscriptTail(
			readRange(path, Math.max(0, size - TAIL_BYTES), TAIL_BYTES),
		);
		const entry =
			isImportable(head, tail.title) && head.sessionId && head.cwd
				? {
						claudeSessionId: head.sessionId,
						cwd: head.cwd,
						branch: branchOf(tail.branch ?? head.branch),
						title: tail.title,
						firstPrompt: head.firstPrompt,
						lastPrompt: tail.lastPrompt,
						startedAt: head.startedAt ?? mtime,
						lastActiveAt: mtime,
						bytes: size,
					}
				: null;
		this.files.set(path, { key, entry });
		return entry;
	}
}

/** "HEAD" is how a transcript says detached. */
const branchOf = (branch: string | null) =>
	branch && branch !== "HEAD" ? branch : null;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** `length` bytes of a file from `start`, as text; "" when it cannot be read. */
function readRange(path: string, start: number, length: number): string {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(length);
		const read = readSync(fd, buffer, 0, length, start);
		return buffer.subarray(0, read).toString("utf8");
	} catch {
		return "";
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

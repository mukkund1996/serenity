import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import {
	type CreateSessionParams,
	hookSettingsPath,
	isHookKind,
	type Method,
	type Params,
	type RepoState,
	type Result,
	RpcError,
	RpcErrorCode,
	RpcPeer,
	reduceHook,
	type Session,
	type Storage,
	selfCommand,
	socketPath,
	tmuxSessionName,
	VERSION,
} from "@serenity/core";
import {
	addWorktree,
	branchExists,
	currentBranch,
	defaultBase,
	siblingWorktreePath,
} from "./git";
import { shellQuote, writeHookSettings } from "./hooks";
import { Tmux } from "./tmux";

export interface DaemonOptions {
	home: string;
	storage: Storage;
	tmux?: Tmux;
	/** The command spawned for each session; SERENITY_CLAUDE_BIN overrides it (the E2E fake). */
	claudeCommand?: string[];
	now?: () => number;
	log?: (line: string) => void;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/i;
/** Width of the agent pane when attached: the right ⅔ (ADR 0004). */
const ATTACH_PERCENT = 67;

type Handlers = {
	[M in Method]: (
		params: Params<M>,
		peer: RpcPeer,
	) => Promise<Result<M>> | Result<M>;
};

export class Daemon {
	private server: Server | null = null;
	private readonly subscriptions = new Map<RpcPeer, Set<string>>();
	/** repo → the attached session and the serenity pane it was joined into. */
	private readonly attached = new Map<
		string,
		{ sessionId: string; clientPane: string }
	>();
	private readonly tmux: Tmux;
	private readonly self = selfCommand();
	private readonly claudeCommand: string[];
	private readonly now: () => number;
	private readonly log: (line: string) => void;
	private stopped: (() => void) | null = null;
	readonly done: Promise<void>;

	constructor(private readonly opts: DaemonOptions) {
		this.tmux = opts.tmux ?? new Tmux();
		this.claudeCommand = opts.claudeCommand ?? [
			process.env.SERENITY_CLAUDE_BIN ?? "claude",
		];
		this.now = opts.now ?? Date.now;
		this.log =
			opts.log ??
			((line) => console.log(`${new Date().toISOString()} ${line}`));
		this.done = new Promise((resolve) => {
			this.stopped = resolve;
		});
	}

	async start(): Promise<void> {
		mkdirSync(this.opts.home, { recursive: true });
		writeHookSettings(hookSettingsPath(this.opts.home), this.self);
		const path = socketPath(this.opts.home);
		if (existsSync(path)) rmSync(path);
		this.server = createServer((socket) => this.accept(new RpcPeer(socket)));
		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(path, resolve);
		});
		this.log(`serenityd ${VERSION} listening on ${path} (pid ${process.pid})`);
	}

	async stop(): Promise<void> {
		for (const peer of this.subscriptions.keys()) peer.close();
		await new Promise<void>((resolve) =>
			this.server ? this.server.close(() => resolve()) : resolve(),
		);
		rmSync(socketPath(this.opts.home), { force: true });
		this.opts.storage.close();
		this.stopped?.();
	}

	private accept(peer: RpcPeer): void {
		this.subscriptions.set(peer, new Set());
		peer.onClose(() => this.subscriptions.delete(peer));
		peer.onRequest((method, params) => {
			const handler = this.handlers[method as Method] as
				| ((p: unknown, peer: RpcPeer) => unknown)
				| undefined;
			if (!handler)
				throw new RpcError(
					RpcErrorCode.MethodNotFound,
					`unknown method ${method}`,
				);
			return handler(params ?? {}, peer);
		});
	}

	state(repo: string): RepoState {
		return {
			repo,
			sessions: this.opts.storage.sessions.listByRepo(repo),
			attachedSessionId: this.attached.get(repo)?.sessionId ?? null,
		};
	}

	private broadcast(repo: string): void {
		const state = this.state(repo);
		for (const [peer, repos] of this.subscriptions)
			if (repos.has(repo)) peer.notify("state.changed", state);
	}

	private requireSession(id: string | undefined): Session {
		const session = id ? this.opts.storage.sessions.get(id) : null;
		if (!session)
			throw new RpcError(RpcErrorCode.InvalidParams, `no session ${id}`);
		return session;
	}

	private update(session: Session, patch: Partial<Session>): Session {
		const next = { ...session, ...patch, updatedAt: this.now() };
		this.opts.storage.sessions.put(next);
		return next;
	}

	private readonly handlers: Handlers = {
		hello: () => ({ daemonVersion: VERSION, pid: process.pid }),

		"state.subscribe": ({ repo }, peer) => {
			this.subscriptions.get(peer)?.add(repo);
			return this.state(repo);
		},

		"session.create": (params) => this.createSession(params),

		"session.reply": async ({ id, text }) => {
			const session = this.requireSession(id);
			if (
				!session.tmuxPane ||
				!(await this.tmux.paneExists(session.tmuxPane))
			) {
				throw new RpcError(
					RpcErrorCode.InvalidParams,
					`${session.name} has no live pane`,
				);
			}
			await this.tmux.sendText(session.tmuxPane, text);
			return null;
		},

		"session.attach": async ({ id, clientPane }) => {
			const session = this.requireSession(id);
			const pane = session.tmuxPane;
			if (!pane || !(await this.tmux.paneExists(pane))) {
				throw new RpcError(
					RpcErrorCode.InvalidParams,
					`${session.name} has no live pane`,
				);
			}
			const current = this.attached.get(session.repo);
			if (current) await this.detach(current.sessionId);
			await this.tmux.bindDetachKey(this.detachCommand());
			await this.tmux.joinRight(pane, clientPane, ATTACH_PERCENT);
			this.attached.set(session.repo, { sessionId: session.id, clientPane });
			this.broadcast(session.repo);
			return null;
		},

		"session.detach": async ({ pane, id }) => {
			const session = id
				? this.requireSession(id)
				: this.opts.storage.sessions.listAll().find((s) => s.tmuxPane === pane);
			if (session) await this.detach(session.id);
			return null;
		},

		"hook.event": ({ sessionId, kind, payload }) => {
			if (!isHookKind(kind))
				throw new RpcError(RpcErrorCode.InvalidParams, `unknown hook ${kind}`);
			const session = this.opts.storage.sessions.get(sessionId);
			if (!session) return null;
			this.opts.storage.transaction(() => {
				this.opts.storage.events.append({
					sessionId,
					kind,
					payload,
					at: this.now(),
				});
				this.update(session, reduceHook(session, kind, payload));
			});
			this.broadcast(session.repo);
			return null;
		},

		"daemon.shutdown": () => {
			setTimeout(() => void this.stop(), 10);
			return null;
		},
	};

	/**
	 * The shell command the Ctrl+g binding runs. tmux runs it with the server's
	 * environment, so the daemon's home and tmux socket are passed explicitly.
	 */
	private detachCommand(): string {
		const env = [`SERENITY_HOME=${this.opts.home}`];
		if (process.env.SERENITY_TMUX_SOCKET)
			env.push(`SERENITY_TMUX_SOCKET=${process.env.SERENITY_TMUX_SOCKET}`);
		return ["env", ...env, ...this.self, "detach"].map(shellQuote).join(" ");
	}

	private async detach(sessionId: string): Promise<void> {
		const session = this.requireSession(sessionId);
		const attached = this.attached.get(session.repo);
		if (attached?.sessionId !== sessionId) return;
		this.attached.delete(session.repo);
		if (session.tmuxPane && (await this.tmux.paneExists(session.tmuxPane))) {
			await this.tmux.park(
				session.tmuxPane,
				tmuxSessionName(session.repo),
				session.name,
			);
		}
		if (await this.tmux.paneExists(attached.clientPane))
			await this.tmux.selectPane(attached.clientPane);
		this.broadcast(session.repo);
	}

	private async createSession(params: CreateSessionParams): Promise<Session> {
		const { repo, mode } = params;
		const name = params.name.trim();
		if (!NAME_PATTERN.test(name)) {
			throw new RpcError(
				RpcErrorCode.InvalidParams,
				"name: letters, digits, . _ - (max 40)",
			);
		}
		const clash = this.opts.storage.sessions
			.listByRepo(repo)
			.find(
				(s) =>
					s.name === name && s.status !== "archived" && s.status !== "dead",
			);
		if (clash)
			throw new RpcError(
				RpcErrorCode.InvalidParams,
				`a session named ${name} already exists`,
			);

		const branch = params.branch?.trim() || name;
		let cwd = params.cwd;
		let worktree: string | null = null;
		if (mode === "worktree") {
			if (await branchExists(repo, branch)) {
				throw new RpcError(
					RpcErrorCode.InvalidParams,
					`branch ${branch} exists; use existing branch`,
				);
			}
			worktree = siblingWorktreePath(repo, name);
			await addWorktree(repo, worktree, {
				newBranch: branch,
				base: await defaultBase(repo),
			});
			cwd = worktree;
		} else if ((await currentBranch(params.cwd)) !== branch) {
			if (!(await branchExists(repo, branch)))
				throw new RpcError(RpcErrorCode.InvalidParams, `no branch ${branch}`);
			worktree = siblingWorktreePath(repo, name);
			await addWorktree(repo, worktree, { branch });
			cwd = worktree;
		}

		const id = randomUUID();
		const tmuxSession = tmuxSessionName(repo);
		await this.tmux.ensureSession(tmuxSession, repo);
		const pane = await this.tmux.newWindow({
			session: tmuxSession,
			name,
			cwd,
			env: { SERENITY_SESSION_ID: id, SERENITY_HOME: this.opts.home },
			command: [
				...this.claudeCommand,
				"--settings",
				hookSettingsPath(this.opts.home),
			],
		});
		await this.tmux.setPaneOption(pane, "@serenity_session", id);

		const at = this.now();
		const session: Session = {
			id,
			repo,
			name,
			category: null,
			cwd,
			worktree,
			branch,
			tmuxPane: pane,
			status: "idle",
			summary: null,
			ask: null,
			lastPrompt: null,
			lastAssistantMessage: null,
			transcriptPath: null,
			claudeSessionId: null,
			watched: false,
			createdAt: at,
			updatedAt: at,
		};
		this.opts.storage.sessions.put(session);
		this.log(`created ${name} in ${cwd} (pane ${pane})`);
		this.broadcast(repo);
		return session;
	}
}

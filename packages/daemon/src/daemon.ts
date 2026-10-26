import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import {
	averageWait,
	BUILD_ID,
	type CleanupPlan,
	type CreateSessionParams,
	hookSettingsPath,
	isHookKind,
	loadConfig,
	type Method,
	type Params,
	parseRateLimits,
	type RepoState,
	type Result,
	RpcError,
	RpcErrorCode,
	RpcPeer,
	reduceHook,
	type Session,
	STARTUP_ASK,
	type Storage,
	selfCommand,
	socketPath,
	tmuxSessionName,
	type Usage,
	usageChanged,
	WAIT_WINDOW_MS,
	waitChange,
} from "@serenity/core";
import { ClaudeObserver } from "./adopt";
import { type ClaudeRunner, CliClaudeRunner } from "./claude";
import { type CleanupFacts, cleanupPlan, plannedRemovals } from "./cleanup";
import { run } from "./exec";
import { Gh } from "./gh";
import {
	addWorktree,
	branchExists,
	branchSha,
	commitsNotIn,
	currentBranch,
	defaultBase,
	deleteBranch,
	dirtyCount,
	removeWorktree,
	siblingWorktreePath,
} from "./git";
import { agentCommand, shellQuote, writeHookSettings } from "./hooks";
import { type MasterModels, MasterSupervisor } from "./master";
import { PrWatcher, workDir } from "./prs";
import { ReviewWatcher } from "./reviews";
import { Tmux } from "./tmux";

export interface DaemonOptions {
	home: string;
	storage: Storage;
	tmux?: Tmux;
	/** The command spawned for each session; SERENITY_CLAUDE_BIN overrides it (the E2E fake). */
	claudeCommand?: string[];
	/** Runs the master's claude processes; defaults to the CLI. */
	runner?: ClaudeRunner;
	/** Reads PRs; SERENITY_GH_BIN points the default at the E2E fake. */
	gh?: Gh;
	/** Fallback reviewers when CODEOWNERS names nobody; defaults to config. */
	reviewers?: string[];
	models?: MasterModels;
	/** Most topics per repo; defaults to config. */
	maxTopics?: number;
	now?: () => number;
	log?: (line: string) => void;
	/**
	 * How long a new session may stay silent before it is shown as waiting on
	 * Claude's startup prompt. SERENITY_STARTUP_GRACE_MS overrides it.
	 */
	startupGraceMs?: number;
	/** Quiet time before a summary or suggestion runs; SERENITY_WORKER_DEBOUNCE_MS overrides it. */
	workerDebounceMs?: number;
	/** Claude Code's config dir, where adoptable sessions are found; defaults to CLAUDE_CONFIG_DIR or ~/.claude. */
	claudeConfigDir?: string;
	/** How often review requests are polled while a map is open; SERENITY_REVIEW_POLL_MS overrides it. */
	reviewPollMs?: number;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/i;
/** Width of the agent pane when attached: the right ⅔ (ADR 0004). */
const ATTACH_PERCENT = 67;
/**
 * Claude fires no hooks until the folder trust prompt is answered, and every
 * new worktree is an untrusted folder; silence after this long means it waits.
 */
const DEFAULT_STARTUP_GRACE_MS = 5000;
/** A burst of hooks (tool calls, then Stop) yields one model call. */
const DEFAULT_WORKER_DEBOUNCE_MS = 1500;
/** Review requests fire no event, so an open map polls them this often. */
const DEFAULT_REVIEW_POLL_MS = 5 * 60_000;
/** Messages of the master conversation sent to clients. */
const CONVERSATION_SHOWN = 4;

type Handlers = {
	[M in Method]: (
		params: Params<M>,
		peer: RpcPeer,
	) => Promise<Result<M>> | Result<M>;
};

const envNumber = (name: string, fallback: number) =>
	process.env[name] ? Number(process.env[name]) : fallback;

export class Daemon {
	private server: Server | null = null;
	private readonly subscriptions = new Map<RpcPeer, Set<string>>();
	/** Each map's tmux pane, given when it subscribes; the master attaches there. */
	private readonly mapPanes = new Map<RpcPeer, string>();
	/**
	 * repo → the attached session and the map pane it was joined into. For an
	 * adopted session, `clientTty` is the tmux client that was switched to it.
	 */
	private readonly attached = new Map<
		string,
		{ sessionId: string; clientPane: string; clientTty?: string }
	>();
	private readonly tmux: Tmux;
	private readonly self = selfCommand();
	private readonly claudeCommand: string[];
	private readonly now: () => number;
	private readonly log: (line: string) => void;
	private readonly startupGraceMs: number;
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();
	private readonly master: MasterSupervisor;
	private readonly gh: Gh;
	private readonly prs: PrWatcher;
	private readonly reviews: ReviewWatcher;
	private readonly observer: ClaudeObserver;
	/** Plan usage is per account, so the latest report covers every repo. */
	private usage: Usage | null = null;
	private stopped: (() => void) | null = null;
	readonly done: Promise<void>;

	constructor(private readonly opts: DaemonOptions) {
		this.tmux = opts.tmux ?? new Tmux();
		this.claudeCommand = opts.claudeCommand ?? [
			process.env.SERENITY_CLAUDE_BIN ?? "claude",
		];
		this.now = opts.now ?? Date.now;
		this.startupGraceMs =
			opts.startupGraceMs ??
			envNumber("SERENITY_STARTUP_GRACE_MS", DEFAULT_STARTUP_GRACE_MS);
		this.log =
			opts.log ??
			((line) => console.log(`${new Date().toISOString()} ${line}`));
		const config = loadConfig();
		this.master = new MasterSupervisor(
			{
				storage: opts.storage,
				now: this.now,
				log: this.log,
				broadcast: (repo) => this.broadcast(repo),
				update: (session, patch) => this.update(session, patch),
				kill: (session) => this.kill(session),
				open: (session) => this.open(session),
				mcpConfig: (repo) => this.mcpConfig(repo),
				workerCwd: join(opts.home, "workers"),
				models: opts.models ?? config.models,
				maxTopics: opts.maxTopics ?? config.maxTopics,
				debounceMs:
					opts.workerDebounceMs ??
					envNumber("SERENITY_WORKER_DEBOUNCE_MS", DEFAULT_WORKER_DEBOUNCE_MS),
			},
			opts.runner ?? new CliClaudeRunner(this.claudeCommand),
		);
		this.gh = opts.gh ?? new Gh();
		this.prs = new PrWatcher({
			storage: opts.storage,
			gh: this.gh,
			reviewers: opts.reviewers ?? config.reviewers,
			change: (session, patch) => this.change(session, patch),
			broadcast: (repo) => this.broadcast(repo),
			propose: (session, kind, label, text, source) =>
				this.master.propose(session, kind, label, text, source),
			log: this.log,
			debounceMs:
				opts.workerDebounceMs ??
				envNumber("SERENITY_WORKER_DEBOUNCE_MS", DEFAULT_WORKER_DEBOUNCE_MS),
		});
		this.reviews = new ReviewWatcher({
			gh: this.gh,
			watching: (repo) =>
				[...this.subscriptions.values()].some((repos) => repos.has(repo)),
			broadcast: (repo) => this.broadcast(repo),
			log: this.log,
			pollMs:
				opts.reviewPollMs ??
				envNumber("SERENITY_REVIEW_POLL_MS", DEFAULT_REVIEW_POLL_MS),
		});
		this.observer = new ClaudeObserver(
			{
				storage: opts.storage,
				tmux: this.tmux,
				now: this.now,
				change: (session, patch) => this.change(session, patch),
				broadcast: (repo) => this.broadcast(repo),
				markEnded: (session) => this.markEnded(session),
				bindDetachKey: async () => {
					await this.tmux.bindDetachKey(this.detachCommand());
				},
				log: this.log,
			},
			opts.claudeConfigDir,
		);
		this.done = new Promise((resolve) => {
			this.stopped = resolve;
		});
	}

	async start(): Promise<void> {
		mkdirSync(join(this.opts.home, "workers"), { recursive: true });
		writeHookSettings(hookSettingsPath(this.opts.home), this.self);
		const path = socketPath(this.opts.home);
		if (existsSync(path)) rmSync(path);
		this.server = createServer((socket) => this.accept(new RpcPeer(socket)));
		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(path, resolve);
		});
		this.observer.start();
		this.log(`serenityd ${BUILD_ID} listening on ${path} (pid ${process.pid})`);
	}

	async stop(): Promise<void> {
		for (const timer of this.timers) clearTimeout(timer);
		this.master.stop();
		this.prs.stop();
		this.reviews.stop();
		this.observer.stop();
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
		peer.onClose(() => {
			this.subscriptions.delete(peer);
			this.mapPanes.delete(peer);
		});
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
			suggestions: this.opts.storage.suggestions.listPending(repo),
			conversation: this.opts.storage.conversation.listRecent(
				repo,
				CONVERSATION_SHOWN,
			),
			permissions: this.master.permissions(repo),
			master: this.master.state(repo),
			github: this.reviews.state(repo),
			usage: this.usage,
			averageWaitMs: averageWait(
				this.opts.storage.waits.listSince(repo, this.now() - WAIT_WINDOW_MS),
			),
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
		const now = this.now();
		const next = { ...session, ...patch, updatedAt: now };
		const { waitingSince, ended } = waitChange(session, next, now);
		next.waitingSince = waitingSince;
		this.opts.storage.transaction(() => {
			this.opts.storage.sessions.put(next);
			if (ended) this.opts.storage.waits.append(ended);
		});
		return next;
	}

	/** Updates a session and lets the master react (summaries, suggestions). */
	private change(session: Session, patch: Partial<Session>): Session {
		const next = this.update(session, patch);
		this.master.onSessionChanged(session, next);
		return next;
	}

	private readonly handlers: Handlers = {
		hello: () => ({ daemonVersion: BUILD_ID, pid: process.pid }),

		"state.subscribe": ({ repo, clientPane }, peer) => {
			this.subscriptions.get(peer)?.add(repo);
			if (clientPane) this.mapPanes.set(peer, clientPane);
			this.prs.refreshRepo(repo);
			this.reviews.watch(repo);
			return this.state(repo);
		},

		"session.create": (params) => this.createSession(params),

		"session.reply": async ({ id, text }) => {
			const pane = await this.requireLivePane(this.requireSession(id));
			await this.tmux.sendText(pane, text);
			return null;
		},

		"session.attach": async ({ id, clientPane }) => {
			await this.attach(this.requireSession(id), clientPane);
			return null;
		},

		"session.detach": async ({ pane, id, clientPane }) => {
			const sessionId = clientPane
				? [...this.attached.values()].find((a) => a.clientPane === clientPane)
						?.sessionId
				: id
					? this.requireSession(id).id
					: this.opts.storage.sessions
							.listAll()
							.find((s) => s.tmuxPane === pane)?.id;
			if (sessionId) await this.detach(sessionId);
			return null;
		},

		"session.discover": ({ repo }) => this.observer.candidates(repo),

		"session.adopt": ({ repo, claudeSessionIds }) =>
			this.observer.adopt(repo, claudeSessionIds),

		"session.upgrade": async ({ id }) => {
			await this.upgrade(this.requireSession(id));
			return null;
		},

		"session.rename": ({ id, name }) =>
			this.rename(this.requireSession(id), name),

		"session.watch": ({ id, watched }) => {
			const session = this.requireSession(id);
			this.change(session, { watched });
			this.broadcast(session.repo);
			return null;
		},

		"session.pin": ({ id, pinned }) => {
			const session = this.requireSession(id);
			if (session.status === "archived")
				throw new RpcError(
					RpcErrorCode.InvalidParams,
					`${session.name} is archived`,
				);
			// A pinned session is never done: it waits for its next task.
			this.change(session, {
				pinned,
				...(pinned && session.status === "done" ? { status: "idle" } : {}),
			});
			if (pinned) this.master.supersede(session.id, "cleanup");
			this.broadcast(session.repo);
			return null;
		},

		"session.cleanupPlan": async ({ id }) =>
			cleanupPlan(
				this.requireSession(id),
				await this.cleanupFacts(this.requireSession(id)),
			),

		"session.cleanup": async ({ id }) => {
			await this.cleanup(this.requireSession(id));
			return null;
		},

		"session.kill": async ({ id }) => {
			await this.kill(this.requireSession(id));
			return null;
		},

		"suggestion.accept": async ({ id, text }) => {
			const suggestion = this.opts.storage.suggestions.get(id);
			if (suggestion?.status !== "pending")
				throw new RpcError(
					RpcErrorCode.InvalidParams,
					"that suggestion is no longer pending",
				);
			const session = this.requireSession(suggestion.sessionId);
			const settle = (status: "accepted" | "failed") =>
				this.opts.storage.suggestions.put({
					...suggestion,
					status,
					updatedAt: this.now(),
				});
			try {
				if (suggestion.kind === "reply") {
					const pane = await this.requireLivePane(session);
					await this.tmux.sendText(pane, text ?? suggestion.text ?? "");
				} else if (suggestion.kind === "approve") {
					if (session.waitingOn !== "permission")
						throw new RpcError(
							RpcErrorCode.InvalidParams,
							`${session.name} is no longer waiting on a permission prompt`,
						);
					// "1" picks "Yes" in Claude Code's numbered permission menu.
					await this.tmux.pressKey(await this.requireLivePane(session), "1");
				} else if (suggestion.kind === "review") {
					if (session.pr?.state !== "OPEN")
						throw new RpcError(
							RpcErrorCode.InvalidParams,
							`${session.name} has no open PR`,
						);
					await this.gh.requestReview(
						workDir(session),
						session.pr.number,
						text ?? suggestion.text ?? "",
					);
					this.prs.schedule(session.id, 0);
				} else {
					await this.cleanup(session);
				}
				settle("accepted");
			} catch (error) {
				settle("failed");
				throw error;
			} finally {
				this.broadcast(session.repo);
			}
			return null;
		},

		"suggestion.decline": ({ id }) => {
			const suggestion = this.opts.storage.suggestions.get(id);
			if (suggestion?.status === "pending") {
				this.opts.storage.suggestions.put({
					...suggestion,
					status: "declined",
					updatedAt: this.now(),
				});
				this.broadcast(suggestion.repo);
			}
			return null;
		},

		"master.message": ({ repo, text }) => {
			if (!text.trim())
				throw new RpcError(RpcErrorCode.InvalidParams, "empty message");
			this.master.message(repo, text.trim());
			return null;
		},

		"master.permission": ({ id, allow }) => {
			if (!this.master.answerPermission(id, allow))
				throw new RpcError(
					RpcErrorCode.InvalidParams,
					"that request is no longer pending",
				);
			return null;
		},

		"master.tool": ({ repo, name, args }) =>
			this.master.handleTool(repo, name, args),

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
				this.change(session, reduceHook(session, kind, payload));
			});
			// A turn ended: commits may have been pushed or a PR opened.
			if (kind === "Stop") this.prs.schedule(session.id);
			this.broadcast(session.repo);
			return null;
		},

		"session.exited": ({ sessionId, code }) => {
			const session = this.opts.storage.sessions.get(sessionId);
			if (!session) return null;
			this.log(`${session.name} exited (code ${code ?? "unknown"})`);
			this.markEnded(session);
			return null;
		},

		"usage.report": ({ rateLimits }) => {
			const usage = parseRateLimits(rateLimits, this.now());
			if (!usage) return null;
			const changed = usageChanged(this.usage, usage);
			this.usage = usage;
			if (changed)
				for (const repo of new Set(
					[...this.subscriptions.values()].flatMap((repos) => [...repos]),
				))
					this.broadcast(repo);
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

	/** `--mcp-config` for a repo's master chat: `serenity mcp <repo>` (ADR 0008). */
	private mcpConfig(repo: string): string {
		const [command, ...args] = this.self;
		return JSON.stringify({
			mcpServers: {
				serenity: {
					type: "stdio",
					command,
					args: [...args, "mcp", repo],
					env: { SERENITY_HOME: this.opts.home },
				},
			},
		});
	}

	/** The session's pane id; if the pane is gone, the session is marked ended. */
	private async requireLivePane(session: Session): Promise<string> {
		const pane = session.tmuxPane;
		if (pane && (await this.tmux.paneExists(pane))) return pane;
		this.markEnded(session);
		throw new RpcError(RpcErrorCode.InvalidParams, `${session.name} has ended`);
	}

	private markEnded(session: Session): void {
		if (this.attached.get(session.repo)?.sessionId === session.id)
			this.attached.delete(session.repo);
		if (session.status !== "dead" && session.status !== "archived")
			this.change(session, { status: "dead", ask: null, waitingOn: null });
		this.broadcast(session.repo);
	}

	/** After the grace period, a session that never said hello is waiting on Claude's startup prompt. */
	private watchStartup(sessionId: string): void {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			const session = this.opts.storage.sessions.get(sessionId);
			if (!session || session.claudeSessionId || session.status !== "idle")
				return;
			this.update(session, {
				status: "waiting",
				ask: STARTUP_ASK,
				waitingOn: "startup",
			});
			this.broadcast(session.repo);
		}, this.startupGraceMs);
		this.timers.add(timer);
	}

	private async detach(sessionId: string): Promise<void> {
		const session = this.requireSession(sessionId);
		const attached = this.attached.get(session.repo);
		if (attached?.sessionId !== sessionId) return;
		this.attached.delete(session.repo);
		if (attached.clientTty) {
			// Adopted: its pane stays put; bring the client back to the map.
			if (await this.tmux.paneExists(attached.clientPane))
				await this.tmux
					.switchClient(attached.clientTty, attached.clientPane)
					.catch(() => {});
		} else if (
			session.tmuxPane &&
			(await this.tmux.paneExists(session.tmuxPane))
		) {
			await this.tmux.park(
				session.tmuxPane,
				tmuxSessionName(session.repo),
				session.name,
			);
		}
		if (await this.tmux.paneExists(attached.clientPane))
			await this.tmux.selectPane(attached.clientPane);
		this.prs.schedule(session.id, 0);
		this.broadcast(session.repo);
	}

	private async cleanupFacts(session: Session): Promise<CleanupFacts> {
		const alive =
			!!session.tmuxPane && (await this.tmux.paneExists(session.tmuxPane));
		const worktreeOnDisk = !!session.worktree && existsSync(session.worktree);
		const dirty = worktreeOnDisk
			? await dirtyCount(session.worktree as string).catch(() => null)
			: session.worktree
				? 0
				: null;
		const base = await defaultBase(session.repo).catch(() => "HEAD");
		const unmerged =
			session.branch && session.ownsBranch
				? await commitsNotIn(session.repo, base, session.branch).catch(
						() => null,
					)
				: null;
		// A squash-merged PR whose head is still the branch's commit (ADR 0011).
		const pr = session.pr;
		const prMerged =
			pr?.state === "MERGED" &&
			session.branch &&
			(await branchSha(session.repo, session.branch)) === pr.headRefOid
				? pr.number
				: null;
		return { alive, dirty, unmerged, base, prMerged };
	}

	/**
	 * Stops the agent, removes its worktree and its merged branch when nothing
	 * would be lost, and archives the node (design 4b).
	 */
	private async cleanup(session: Session): Promise<CleanupPlan> {
		const facts = await this.cleanupFacts(session);
		const removals = plannedRemovals(session, facts);
		await this.stopAgent(session, facts.alive);
		if (removals.removeWorktree && session.worktree) {
			if (existsSync(session.worktree))
				await removeWorktree(session.repo, session.worktree);
			else await run(["git", "-C", session.repo, "worktree", "prune"]);
		}
		if (removals.deleteBranch && session.branch)
			await deleteBranch(session.repo, session.branch, removals.forceDelete);
		this.log(`cleaned up ${session.name}`);
		this.broadcast(session.repo);
		return cleanupPlan(session, facts);
	}

	/**
	 * Joins the session's pane beside the map pane, or switches to an adopted
	 * one. A pinned session that ended is resumed first.
	 */
	private async attach(found: Session, clientPane: string): Promise<void> {
		const session = found.pinned ? await this.resume(found) : found;
		const pane = await this.requireLivePane(session);
		const current = this.attached.get(session.repo);
		if (current) await this.detach(current.sessionId);
		await this.tmux.bindDetachKey(this.detachCommand());
		await this.tmux
			.enableClaudeKeys()
			.catch((e: Error) => this.log(`tmux claude keys: ${e.message}`));
		if (session.origin === "adopted") {
			// Its pane stays in the user's own window; go there (ADR 0016).
			const clientTty = await this.tmux.clientShowing(clientPane);
			if (!clientTty)
				throw new RpcError(
					RpcErrorCode.InvalidParams,
					"no tmux client is showing the map",
				);
			await this.tmux.switchClient(clientTty, pane);
			this.attached.set(session.repo, {
				sessionId: session.id,
				clientPane,
				clientTty,
			});
		} else {
			await this.tmux.joinRight(pane, clientPane, ATTACH_PERCENT);
			this.attached.set(session.repo, { sessionId: session.id, clientPane });
		}
		this.prs.schedule(session.id, 0);
		this.broadcast(session.repo);
	}

	/**
	 * Brings back a pinned session whose pane is gone in a new window of its
	 * own, continuing its conversation with `claude --resume` (ADR 0022). An
	 * imported one comes back as serenity's, under its hooks.
	 */
	private async resume(session: Session): Promise<Session> {
		if (session.status === "archived") return session;
		if (session.tmuxPane && (await this.tmux.paneExists(session.tmuxPane)))
			return session;
		if (!existsSync(session.cwd))
			throw new RpcError(
				RpcErrorCode.InvalidParams,
				`${session.name} cannot resume: ${session.cwd} is gone`,
			);
		if (session.tracking === "observed") this.observer.forget(session.id);
		const tmuxSession = tmuxSessionName(session.repo);
		await this.tmux.ensureSession(tmuxSession, session.repo);
		const resume = session.claudeSessionId
			? ["--resume", session.claudeSessionId]
			: [];
		const pane = await this.tmux.newWindow({
			session: tmuxSession,
			name: session.name,
			cwd: session.cwd,
			env: { SERENITY_SESSION_ID: session.id, SERENITY_HOME: this.opts.home },
			command: agentCommand(
				[...this.claudeCommand, ...resume],
				hookSettingsPath(this.opts.home),
				this.self,
			),
		});
		await this.tmux.setPaneOption(pane, "@serenity_session", session.id);
		const next = this.change(session, {
			tmuxPane: pane,
			origin: "spawned",
			tracking: "hooks",
			claudePid: null,
			status: "idle",
			ask: null,
			waitingOn: null,
		});
		this.watchStartup(session.id);
		this.log(`resumed ${session.name} in ${session.cwd} (pane ${pane})`);
		this.broadcast(session.repo);
		return next;
	}

	/** The master's open_session: attach beside a map showing this repo. */
	private async open(session: Session): Promise<void> {
		const pane = [...this.mapPanes].find(([peer]) =>
			this.subscriptions.get(peer)?.has(session.repo),
		)?.[1];
		if (!pane)
			throw new RpcError(
				RpcErrorCode.InvalidParams,
				"no serenity map inside tmux is showing this repo",
			);
		await this.attach(session, pane);
	}

	/**
	 * Stops the agent and archives its node, which leaves the map for the
	 * archived list. Its worktree and branch stay; cleanup removes those.
	 */
	private async kill(session: Session): Promise<void> {
		const alive =
			!!session.tmuxPane && (await this.tmux.paneExists(session.tmuxPane));
		await this.stopAgent(session, alive);
		this.log(`killed ${session.name}`);
		this.broadcast(session.repo);
	}

	private async stopAgent(session: Session, alive: boolean): Promise<void> {
		if (this.attached.get(session.repo)?.sessionId === session.id)
			await this.detach(session.id);
		// Archive first, so the exit that killing the pane causes changes nothing.
		this.change(session, {
			status: "archived",
			ask: null,
			waitingOn: null,
			tmuxPane: null,
		});
		if (alive && session.tmuxPane) {
			if (session.tracking === "observed") {
				// The user's own pane: stop claude, keep their shell and window.
				await this.tmux
					.unsetPaneOption(session.tmuxPane, "@serenity_session")
					.catch(() => {});
				if (session.claudePid) stopProcess(session.claudePid);
			} else await this.tmux.killPane(session.tmuxPane).catch(() => {});
		}
	}

	/**
	 * Restarts an adopted session in place with `claude --resume` under
	 * serenity's hooks, for full status (ADR 0016). Only while Claude is idle,
	 * so no turn is cut short.
	 */
	private async upgrade(session: Session): Promise<void> {
		if (session.tracking !== "observed" || !session.claudeSessionId)
			throw new RpcError(
				RpcErrorCode.InvalidParams,
				`${session.name} already reports through serenity's hooks`,
			);
		await this.observer.sweep();
		const fresh = this.requireSession(session.id);
		const pane = await this.requireLivePane(fresh);
		if (fresh.status !== "idle" && fresh.status !== "done")
			throw new RpcError(
				RpcErrorCode.InvalidParams,
				`${fresh.name} is busy; restart it once it is idle`,
			);
		this.observer.forget(fresh.id);
		this.change(fresh, { tracking: "hooks", claudePid: null });
		await this.tmux.respawnPane({
			pane,
			cwd: fresh.cwd,
			env: { SERENITY_SESSION_ID: fresh.id, SERENITY_HOME: this.opts.home },
			command: agentCommand(
				[...this.claudeCommand, "--resume", fresh.claudeSessionId as string],
				hookSettingsPath(this.opts.home),
				this.self,
			),
		});
		await this.tmux.setPaneOption(pane, "@serenity_session", fresh.id);
		this.log(`restarted ${fresh.name} under serenity's hooks`);
		this.broadcast(fresh.repo);
	}

	/** A valid session name no live session in the repo uses; throws otherwise. */
	private freeName(repo: string, raw: string, self?: string): string {
		const name = raw.trim();
		if (!NAME_PATTERN.test(name)) {
			throw new RpcError(
				RpcErrorCode.InvalidParams,
				"name: letters, digits, . _ - (max 40)",
			);
		}
		const clash = this.opts.storage.sessions.listByRepo(repo).find(
			(s) =>
				s.id !== self &&
				s.name === name &&
				s.status !== "archived" &&
				// An ended pinned session keeps its name; attaching resumes it.
				(s.status !== "dead" || s.pinned),
		);
		if (clash)
			throw new RpcError(
				RpcErrorCode.InvalidParams,
				`a session named ${name} already exists`,
			);
		return name;
	}

	/**
	 * Renames a session and, for one serenity spawned, its tmux window. An
	 * imported session's window is the user's, so it keeps its name; the
	 * branch and worktree keep theirs too.
	 */
	private async rename(session: Session, raw: string): Promise<Session> {
		const name = this.freeName(session.repo, raw, session.id);
		if (name === session.name) return session;
		const next = this.update(session, { name });
		const attached = this.attached.get(session.repo)?.sessionId === session.id;
		// While attached the pane sits in the map's window; detach parks it
		// under the new name.
		if (session.origin === "spawned" && session.tmuxPane && !attached)
			await this.tmux.renameWindow(session.tmuxPane, name).catch(() => {});
		this.log(`renamed ${session.name} to ${name}`);
		this.broadcast(session.repo);
		return next;
	}

	private async createSession(params: CreateSessionParams): Promise<Session> {
		const { repo, mode } = params;
		const name = this.freeName(repo, params.name);

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
			command: agentCommand(
				this.claudeCommand,
				hookSettingsPath(this.opts.home),
				this.self,
				params.prompt?.trim() || undefined,
			),
		});
		await this.tmux.setPaneOption(pane, "@serenity_session", id);

		const at = this.now();
		const session: Session = {
			id,
			repo,
			name,
			topic: null,
			cwd,
			worktree,
			branch,
			ownsBranch: mode === "worktree",
			pr: null,
			prError: null,
			tmuxPane: pane,
			origin: "spawned",
			tracking: "hooks",
			claudePid: null,
			status: "idle",
			summary: null,
			ask: null,
			waitingOn: null,
			waitingSince: null,
			topicCandidate: null,
			lastPrompt: null,
			lastAssistantMessage: null,
			transcriptPath: null,
			claudeSessionId: null,
			watched: false,
			pinned: false,
			createdAt: at,
			updatedAt: at,
		};
		this.opts.storage.sessions.put(session);
		this.watchStartup(id);
		this.log(`created ${name} in ${cwd} (pane ${pane})`);
		this.broadcast(repo);
		return session;
	}
}

/** SIGTERM, ignoring a process that is already gone. */
function stopProcess(pid: number): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch {}
}

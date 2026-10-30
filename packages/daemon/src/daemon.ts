import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import {
	type Attachment,
	averageWait,
	BUILD_ID,
	type CleanupPlan,
	type CreateSessionParams,
	DependencyHealth,
	hookSettingsPath,
	isHookKind,
	isReservedName,
	loadConfig,
	type Method,
	masterPluginPath,
	type Params,
	parseRateLimits,
	RESPAWN_BASE_MS,
	RESPAWN_WINDOW_MS,
	type RepoState,
	type Result,
	RpcError,
	RpcErrorCode,
	RpcPeer,
	reduceHook,
	respawnDecision,
	resumeArgs,
	type Session,
	SLACK_SERVER,
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
import { onDependency, run } from "./exec";
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
import {
	type MasterModels,
	MasterSupervisor,
	writeMasterPlugin,
} from "./master";
import { PrWatcher, workDir } from "./prs";
import { recoveryPlan } from "./recover";
import { ReviewWatcher } from "./reviews";
import { SlackWatcher } from "./slack";
import { SlackAdvisor } from "./slack-advisor";
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
	/** The first restart's delay after claude exits; SERENITY_RESPAWN_BASE_MS overrides it (ADR 0044). */
	respawnBaseMs?: number;
	/** Repos whose map shows Slack; defaults to config (ADR 0023). */
	slackRepos?: string[];
	/** How often Slack is read while such a map is open; SERENITY_SLACK_POLL_MS overrides it. */
	slackPollMs?: number;
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
/** Neither do Slack messages. Each read is a model call, but a read already in flight is never doubled, so a slow one only skips ticks. */
const DEFAULT_SLACK_POLL_MS = 60_000;
/** Messages of the master conversation sent to clients: the four shown and what PgUp scrolls back to (ADR 0041). */
const CONVERSATION_SHOWN = 50;

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
	/** The repo each map whose user is typing shows (ADR 0047). */
	private readonly typing = new Map<RpcPeer, string>();
	/**
	 * repo → the attached session and the map pane it was joined into. For an
	 * adopted session, `clientTty` is the tmux client that was switched to it.
	 * Stored on every change, so a restart can detach it (ADR 0045).
	 */
	private readonly attached = new Map<string, Attachment>();
	private readonly tmux: Tmux;
	private readonly self = selfCommand();
	private readonly claudeCommand: string[];
	private readonly now: () => number;
	private readonly log: (line: string) => void;
	private readonly startupGraceMs: number;
	private readonly respawnBaseMs: number;
	/** session id → when its claude was restarted, within RESPAWN_WINDOW_MS (ADR 0044). */
	private readonly respawns = new Map<string, number[]>();
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();
	private readonly master: MasterSupervisor;
	private readonly gh: Gh;
	private readonly prs: PrWatcher;
	private readonly reviews: ReviewWatcher;
	private readonly slack: SlackWatcher;
	private readonly advisor: SlackAdvisor;
	private readonly slackRepos: Set<string>;
	/** The Slack MCP server entry, for the inbox worker and the chat. */
	private readonly slackMcp: Record<string, unknown>;
	private readonly observer: ClaudeObserver;
	/** session id → when its last hook arrived; the observer checks Claude's status against it. */
	private readonly hookAt = new Map<string, number>();
	/** Plan usage is per account, so the latest report covers every repo. */
	private usage: Usage | null = null;
	/** gh, git, tmux and Slack are per machine, so their health shows on every map (ADR 0043). */
	private readonly health: DependencyHealth;
	private readonly unhearDependencies: () => void;
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
		this.respawnBaseMs =
			opts.respawnBaseMs ??
			envNumber("SERENITY_RESPAWN_BASE_MS", RESPAWN_BASE_MS);
		this.log =
			opts.log ??
			((line) => console.log(`${new Date().toISOString()} ${line}`));
		const config = loadConfig();
		this.health = new DependencyHealth(() => {
			for (const repo of this.openRepos()) this.broadcast(repo);
		}, this.now);
		this.unhearDependencies = onDependency((dependency, problem) => {
			const before = this.health.issues().length;
			this.health.report(dependency, problem);
			if (problem && this.health.issues().length > before)
				this.log(`${dependency} keeps failing: ${problem}`);
		});
		this.slackRepos = new Set(opts.slackRepos ?? config.slack.repos);
		this.slackMcp = config.slack.mcp;
		const runner = opts.runner ?? new CliClaudeRunner(this.claudeCommand);
		this.master = new MasterSupervisor(
			{
				storage: opts.storage,
				now: this.now,
				log: this.log,
				broadcast: (repo) => this.broadcast(repo),
				update: (session, patch) => this.update(session, patch),
				kill: (session) => this.kill(session),
				open: (session) => this.open(session),
				reply: async (session, text) =>
					this.tmux.sendText(await this.requireLivePane(session), text),
				create: (params) => this.createSession(params),
				pluginDir: masterPluginPath(opts.home),
				mcpConfig: (repo) => this.mcpConfig(repo),
				slack: (repo) =>
					this.slackRepos.has(repo) ? this.slack.state() : null,
				workerCwd: join(opts.home, "workers"),
				models: opts.models ?? config.models,
				maxTopics: opts.maxTopics ?? config.maxTopics,
				debounceMs:
					opts.workerDebounceMs ??
					envNumber("SERENITY_WORKER_DEBOUNCE_MS", DEFAULT_WORKER_DEBOUNCE_MS),
			},
			runner,
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
		const models = opts.models ?? config.models;
		const slackMcpConfig = JSON.stringify({
			mcpServers: { [SLACK_SERVER]: this.slackMcp },
		});
		this.advisor = new SlackAdvisor({
			runner,
			storage: opts.storage,
			model: models.suggester,
			sendModel: models.summarizer,
			cwd: join(opts.home, "workers"),
			mcpConfig: slackMcpConfig,
			reviews: (repo) => this.reviews.state(repo).reviewRequests,
			sendText: async (session, text) =>
				this.tmux.sendText(await this.requireLivePane(session), text),
			refreshInbox: () => void this.slack.refresh(),
			broadcast: (repo) => this.broadcast(repo),
			log: this.log,
		});
		this.slack = new SlackWatcher({
			runner,
			model: models.summarizer,
			cwd: join(opts.home, "workers"),
			mcpConfig: slackMcpConfig,
			dismissals: opts.storage.slackDismissals,
			watching: () => this.openRepos().some((r) => this.slackRepos.has(r)),
			broadcast: () => {
				for (const repo of this.openRepos())
					if (this.slackRepos.has(repo)) this.broadcast(repo);
			},
			onInbox: (items) => {
				for (const repo of this.openRepos())
					if (this.slackRepos.has(repo)) this.advisor.onInbox(repo, items);
			},
			log: this.log,
			now: this.now,
			pollMs:
				opts.slackPollMs ??
				envNumber("SERENITY_SLACK_POLL_MS", DEFAULT_SLACK_POLL_MS),
		});
		this.observer = new ClaudeObserver(
			{
				storage: opts.storage,
				tmux: this.tmux,
				now: this.now,
				change: (session, patch) => this.change(session, patch),
				broadcast: (repo) => this.broadcast(repo),
				markEnded: (session) => this.markEnded(session),
				lastHookAt: (id) => this.hookAt.get(id) ?? 0,
				bindSessionKeys: () => this.tmux.bindSessionKeys(this.detachCommand()),
				log: this.log,
			},
			opts.claudeConfigDir,
		);
		this.usage = opts.storage.recovery.get("usage");
		this.done = new Promise((resolve) => {
			this.stopped = resolve;
		});
	}

	async start(): Promise<void> {
		mkdirSync(join(this.opts.home, "workers"), { recursive: true });
		writeHookSettings(hookSettingsPath(this.opts.home), this.self);
		writeMasterPlugin(masterPluginPath(this.opts.home));
		const path = socketPath(this.opts.home);
		if (existsSync(path)) rmSync(path);
		await this.recover();
		this.server = createServer((socket) => this.accept(new RpcPeer(socket)));
		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(path, resolve);
		});
		this.observer.start();
		this.master.start();
		this.log(`serenityd ${BUILD_ID} listening on ${path} (pid ${process.pid})`);
	}

	/**
	 * Matches what storage says to what is still there after a crash or
	 * restart (ADR 0045): sessions whose pane closed meanwhile have ended,
	 * vanished worktrees are forgotten, attachments are kept only while both
	 * panes live, and timers lost with the old process start again.
	 */
	private async recover(): Promise<void> {
		const storage = this.opts.storage;
		const sessions = storage.sessions.listAll();
		const attached = storage.recovery.get("attached") ?? [];
		const panes = new Set(
			[
				...sessions
					.filter((s) => s.status !== "dead" && s.status !== "archived")
					.map((s) => s.tmuxPane),
				...attached.map((a) => a.clientPane),
			].filter((p): p is string => !!p),
		);
		const livePanes = new Set<string>();
		for (const pane of panes)
			if (await this.tmux.paneExists(pane)) livePanes.add(pane);
		const plan = recoveryPlan({
			sessions,
			attached,
			livePanes,
			exists: existsSync,
		});
		const byId = new Map(sessions.map((s) => [s.id, s]));
		for (const id of plan.worktreeGone) {
			const session = storage.sessions.get(id);
			if (session) this.update(session, { worktree: null });
		}
		for (const id of plan.ended) {
			const session = storage.sessions.get(id);
			if (!session) continue;
			this.log(`${session.name} ended while the daemon was down`);
			this.markEnded(session);
		}
		for (const id of plan.park) {
			const s = byId.get(id);
			if (s?.tmuxPane)
				await this.tmux
					.park(s.tmuxPane, tmuxSessionName(s.repo), s.name)
					.catch((e: Error) => this.log(`park ${s.name}: ${e.message}`));
		}
		for (const a of plan.attached) this.attached.set(a.repo, a);
		this.saveAttached();
		for (const s of sessions) {
			const [last] = storage.events.listForSession(s.id, 1);
			if (last) this.hookAt.set(s.id, last.at);
		}
		for (const id of plan.watchStartup) this.watchStartup(id);
		this.log(
			`recovered ${sessions.length} sessions: ${plan.ended.length} ended, ${plan.worktreeGone.length} worktrees gone, ${plan.attached.length} attached, ${plan.park.length} parked`,
		);
	}

	private saveAttached(): void {
		this.opts.storage.recovery.set("attached", [...this.attached.values()]);
	}

	async stop(): Promise<void> {
		this.unhearDependencies();
		for (const timer of this.timers) clearTimeout(timer);
		this.master.stop();
		this.prs.stop();
		this.reviews.stop();
		this.slack.stop();
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
			const pane = this.mapPanes.get(peer);
			this.mapPanes.delete(peer);
			// A map that closes mid-word no longer holds topic moves.
			this.setTyping(peer, null);
			// The pane may outlive the map, as a shell; Ctrl+m is Enter there again.
			if (pane)
				void this.tmux.unsetPaneOption(pane, "@serenity_map").catch(() => {});
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
			slack: this.slackRepos.has(repo)
				? { ...this.slack.state(), suggestions: this.advisor.list(repo) }
				: null,
			pings: this.master.pings(repo),
			health: this.health
				.issues()
				.filter((i) => i.dependency !== "slack" || this.slackRepos.has(repo)),
		};
	}

	/** Repos with a map open. */
	private openRepos(): string[] {
		return [
			...new Set(
				[...this.subscriptions.values()].flatMap((repos) => [...repos]),
			),
		];
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

	/** Records whether a map's user types; a repo is typing while any of its maps is. */
	private setTyping(peer: RpcPeer, repo: string | null): void {
		const before = this.typing.get(peer);
		if (repo) this.typing.set(peer, repo);
		else this.typing.delete(peer);
		const typing = new Set(this.typing.values());
		for (const r of new Set([before, repo]))
			if (r) this.master.setTyping(r, typing.has(r));
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
		if (next.lastAssistantMessage !== session.lastAssistantMessage)
			this.advisor.onSessionChanged(next);
		return next;
	}

	private readonly handlers: Handlers = {
		hello: () => ({ daemonVersion: BUILD_ID, pid: process.pid }),

		"state.subscribe": ({ repo, clientPane }, peer) => {
			this.subscriptions.get(peer)?.add(repo);
			if (clientPane) {
				this.mapPanes.set(peer, clientPane);
				void this.bindMapKeys(clientPane);
			}
			this.prs.refreshRepo(repo);
			this.reviews.watch(repo);
			if (this.slackRepos.has(repo)) {
				this.slack.watch();
				// A map opened after the last read still gets its suggestions.
				const { items, error } = this.slack.state();
				if (!error) this.advisor.onInbox(repo, items);
			}
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

		"session.detach": async ({ pane, id, clientPane, master }) => {
			const sessionId = clientPane
				? [...this.attached.values()].find((a) => a.clientPane === clientPane)
						?.sessionId
				: id
					? this.requireSession(id).id
					: this.opts.storage.sessions
							.listAll()
							.find((s) => s.tmuxPane === pane)?.id;
			if (sessionId) await this.detach(sessionId, master);
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

		"slack.accept": async ({ repo, itemId, text }) => {
			try {
				await this.advisor.accept(repo, itemId, text);
			} catch (error) {
				throw new RpcError(
					RpcErrorCode.InvalidParams,
					error instanceof Error ? error.message : String(error),
				);
			}
			return null;
		},

		"slack.decline": ({ repo, itemId }) => {
			this.advisor.decline(repo, itemId);
			return null;
		},

		"slack.dismiss": ({ channelId, ts }) => {
			if (!channelId?.trim() || !ts?.trim())
				throw new RpcError(RpcErrorCode.InvalidParams, "no Slack message");
			this.slack.dismiss(channelId, ts);
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
			const at = this.now();
			this.hookAt.set(sessionId, at);
			this.opts.storage.transaction(() => {
				this.opts.storage.events.append({
					sessionId,
					kind,
					payload,
					at,
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
			this.onExit(session, code);
			return null;
		},

		"usage.report": ({ rateLimits }) => {
			const usage = parseRateLimits(rateLimits, this.now());
			if (!usage) return null;
			const changed = usageChanged(this.usage, usage);
			this.usage = usage;
			this.opts.storage.recovery.set("usage", usage);
			if (changed) for (const repo of this.openRepos()) this.broadcast(repo);
			return null;
		},

		"map.typing": ({ repo, typing }, peer) => {
			this.setTyping(peer, typing ? repo : null);
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

	/**
	 * Marks the map pane and binds Ctrl+g / Ctrl+m, so Ctrl+m reaches the map
	 * before any session is attached. Extended keys let tmux tell it from Enter.
	 */
	private async bindMapKeys(pane: string): Promise<void> {
		try {
			await this.tmux.setPaneOption(pane, "@serenity_map", "1");
			await this.tmux.bindSessionKeys(this.detachCommand());
			await this.tmux.enableClaudeKeys();
		} catch (e) {
			this.log(`tmux map keys: ${(e as Error).message}`);
		}
	}

	/**
	 * `--mcp-config` for a repo's master chat: `serenity mcp <repo>` (ADR
	 * 0008), and Slack when the repo has it on (ADR 0023).
	 */
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
				...(this.slackRepos.has(repo) ? { [SLACK_SERVER]: this.slackMcp } : {}),
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

	private markEnded(session: Session, exitNote?: string): void {
		if (this.attached.get(session.repo)?.sessionId === session.id) {
			this.attached.delete(session.repo);
			this.saveAttached();
		}
		if (session.status !== "dead" && session.status !== "archived")
			this.change(session, {
				status: "dead",
				ask: null,
				waitingOn: null,
				subagents: [],
				...(exitNote ? { exitNote } : {}),
			});
		this.broadcast(session.repo);
	}

	/**
	 * Claude exited in a session's pane without serenity ending it: restart it
	 * there, continuing the conversation, after a backoff; or, if it never
	 * started or keeps exiting, end the session with the reason (ADR 0044).
	 */
	private onExit(session: Session, code: number | null): void {
		const now = this.now();
		const recent = (this.respawns.get(session.id) ?? []).filter(
			(at) => now - at < RESPAWN_WINDOW_MS,
		);
		const decision = respawnDecision(
			session,
			code,
			recent.length,
			this.respawnBaseMs,
		);
		if (decision.kind === "ignore") return;
		if (decision.kind === "end") {
			this.respawns.delete(session.id);
			this.log(`${session.name} ended: ${decision.reason}`);
			this.markEnded(session, decision.reason);
			// The pane stays after its command exits (remain-on-exit); close it.
			if (session.tmuxPane)
				void this.tmux.killPane(session.tmuxPane).catch(() => {});
			return;
		}
		this.respawns.set(session.id, [...recent, now]);
		this.change(session, {
			status: "idle",
			ask: null,
			waitingOn: null,
			subagents: [],
			exitNote: decision.note,
		});
		this.broadcast(session.repo);
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			void this.respawn(session.id).catch((e: Error) => {
				const current = this.opts.storage.sessions.get(session.id);
				if (current)
					this.markEnded(current, `claude could not restart: ${e.message}`);
			});
		}, decision.delayMs);
		this.timers.add(timer);
	}

	private async respawn(sessionId: string): Promise<void> {
		const session = this.opts.storage.sessions.get(sessionId);
		// Archived or killed meanwhile: leave it.
		if (!session || session.status === "archived" || session.status === "dead")
			return;
		if (!existsSync(session.cwd)) throw new Error(`${session.cwd} is gone`);
		const pane = await this.launchAgent(session, resumeArgs(session));
		this.change(session, { tmuxPane: pane });
		this.log(`restarted ${session.name} (pane ${pane})`);
		this.broadcast(session.repo);
	}

	/**
	 * Runs claude with `args` under serenity's hooks for `session`: in its
	 * pane if that is still there (an attached one stays attached), else in a
	 * new window. The pane outlives claude (remain-on-exit), so a restart can
	 * reuse it. Returns the pane id.
	 */
	private async launchAgent(
		session: Session,
		args: string[],
		prompt?: string,
	): Promise<string> {
		const env = {
			SERENITY_SESSION_ID: session.id,
			SERENITY_HOME: this.opts.home,
		};
		const command = agentCommand(
			[...this.claudeCommand, ...args],
			hookSettingsPath(this.opts.home),
			this.self,
			prompt,
		);
		let pane = session.tmuxPane;
		if (pane && (await this.tmux.paneExists(pane))) {
			await this.tmux.respawnPane({ pane, cwd: session.cwd, env, command });
		} else {
			const tmuxSession = tmuxSessionName(session.repo);
			await this.tmux.ensureSession(tmuxSession, session.repo);
			pane = await this.tmux.newWindow({
				session: tmuxSession,
				name: session.name,
				cwd: session.cwd,
				env,
				command,
			});
		}
		await this.tmux.setPaneOption(pane, "@serenity_session", session.id);
		await this.tmux.setPaneOption(pane, "remain-on-exit", "on");
		return pane;
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

	/** Detaches; with `master`, then presses Ctrl+m in the map so it focuses the master. */
	private async detach(sessionId: string, master = false): Promise<void> {
		const session = this.requireSession(sessionId);
		const known = this.attached.get(session.repo);
		const attached =
			known?.sessionId === sessionId ? known : await this.shownBeside(session);
		if (!attached) return;
		if (known === attached) {
			this.attached.delete(session.repo);
			this.saveAttached();
		}
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
		if (await this.tmux.paneExists(attached.clientPane)) {
			await this.tmux.selectPane(attached.clientPane);
			if (master) await this.tmux.pressCtrlM(attached.clientPane);
		}
		this.prs.schedule(session.id, 0);
		this.broadcast(session.repo);
	}

	/**
	 * Where a session is shown when the daemon has no record of attaching it
	 * (it restarted since, or the user went to the agent's window in tmux):
	 * beside the map in its window, or on a client of its own. Ctrl+g then
	 * still gets back to the map.
	 */
	private async shownBeside(
		session: Session,
	): Promise<{ clientPane: string; clientTty?: string } | null> {
		const map = this.mapPaneFor(session.repo);
		const pane = session.tmuxPane;
		if (!map || !pane || !(await this.tmux.paneExists(pane))) return null;
		const [here, there] = await Promise.all([
			this.tmux.describePane(pane),
			this.tmux.describePane(map),
		]);
		if (here.session === there.session && here.window === there.window)
			return { clientPane: map };
		const clientTty = await this.tmux.clientShowing(pane);
		return clientTty ? { clientPane: map, clientTty } : null;
	}

	/** The pane of a map inside tmux showing `repo`, if any. */
	private mapPaneFor(repo: string): string | undefined {
		return [...this.mapPanes].find(([peer]) =>
			this.subscriptions.get(peer)?.has(repo),
		)?.[1];
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
			else
				await run(["git", "-C", session.repo, "worktree", "prune"], {
					retry: true,
				});
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
		await this.tmux.bindSessionKeys(this.detachCommand());
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
				repo: session.repo,
				sessionId: session.id,
				clientPane,
				clientTty,
			});
		} else {
			await this.tmux.joinRight(pane, clientPane, ATTACH_PERCENT);
			this.attached.set(session.repo, {
				repo: session.repo,
				sessionId: session.id,
				clientPane,
			});
		}
		this.saveAttached();
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
		const pane = await this.launchAgent(
			{ ...session, tmuxPane: null },
			session.claudeSessionId ? ["--resume", session.claudeSessionId] : [],
		);
		this.respawns.delete(session.id);
		const next = this.change(session, {
			tmuxPane: pane,
			origin: "spawned",
			tracking: "hooks",
			claudePid: null,
			status: "idle",
			ask: null,
			waitingOn: null,
			exitNote: null,
		});
		this.watchStartup(session.id);
		this.log(`resumed ${session.name} in ${session.cwd} (pane ${pane})`);
		this.broadcast(session.repo);
		return next;
	}

	/** The master's open_session: attach beside a map showing this repo. */
	private async open(session: Session): Promise<void> {
		const pane = this.mapPaneFor(session.repo);
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
		await this.launchAgent({ ...fresh, tmuxPane: pane }, [
			"--resume",
			fresh.claudeSessionId as string,
		]);
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
		if (isReservedName(name))
			throw new RpcError(
				RpcErrorCode.InvalidParams,
				`${name} is reserved for @${name.toLowerCase()} in the master; pick another name`,
			);
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
			tmuxPane: null,
			origin: "spawned",
			tracking: "hooks",
			claudePid: null,
			status: "idle",
			summary: null,
			ask: null,
			waitingOn: null,
			waitingSince: null,
			topicCandidate: null,
			topicHeld: null,
			lastPrompt: null,
			lastAssistantMessage: null,
			subagents: [],
			transcriptPath: null,
			claudeSessionId: null,
			watched: false,
			pinned: false,
			exitNote: null,
			createdAt: at,
			updatedAt: at,
		};
		session.tmuxPane = await this.launchAgent(
			session,
			[],
			params.prompt?.trim() || undefined,
		);
		this.opts.storage.sessions.put(session);
		this.watchStartup(id);
		this.log(`created ${name} in ${cwd} (pane ${session.tmuxPane})`);
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

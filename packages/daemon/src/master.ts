import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	applySummary,
	type CreateSessionParams,
	capTopic,
	chatMessage,
	chatSnapshot,
	confirmedReply,
	confirmedSlackSend,
	findSessionByName,
	MASTER_SLACK_PROMPT,
	MASTER_SYSTEM_PROMPT,
	type MasterOutboxItem,
	type MasterPermission,
	type MasterRecord,
	type MasterState,
	type MasterToolResult,
	mentionsSession,
	needsSuggestion,
	normalizeTopic,
	PINNED,
	type Ping,
	parseSuggestion,
	parseSummary,
	type Session,
	SLACK_READ_TOOLS,
	SLACK_SEND_TOOL,
	type SlackInbox,
	type Storage,
	SUGGESTION_SCHEMA,
	type Suggestion,
	type SuggestionKind,
	sameSlackText,
	sessionStatusText,
	suggestionPrompt,
	summaryPrompt,
	summarySchema,
	turnEnded,
	watchMessage,
} from "@serenity/core";
import type { ChatProcess, ClaudeRunner } from "./claude";
import MASTER_SKILL from "./master-skill.md" with { type: "text" };

export interface MasterModels {
	chat: string;
	summarizer: string;
	suggester: string;
}

export interface MasterHost {
	storage: Storage;
	now(): number;
	log(line: string): void;
	broadcast(repo: string): void;
	/** Saves a patch to a session and returns the result. */
	update(session: Session, patch: Partial<Session>): Session;
	/** Stops a session's agent and archives it (the user's `K`). */
	kill(session: Session): Promise<void>;
	/** Attaches a session beside the user's map, as Enter on its card does. */
	open(session: Session): Promise<void>;
	/** Types text into a live session's agent; throws if its pane has ended. */
	reply(session: Session, text: string): Promise<void>;
	/** Starts a new session, as N on the map does. */
	create(params: CreateSessionParams): Promise<Session>;
	/** `--plugin-dir` for the chat: the plugin with the master's skill (writeMasterPlugin). */
	pluginDir: string;
	/** `--mcp-config` JSON for a repo's chat; its server is `serenity mcp <repo>`. */
	mcpConfig(repo: string): string;
	/** The repo's Slack inbox, or null when Slack is off for it (ADR 0023). */
	slack(repo: string): SlackInbox | null;
	/** Where one-shot workers run; not the user's repo, so nothing there is loaded. */
	workerCwd: string;
	models: MasterModels;
	/** Most topics per repo (config `maxTopics`). */
	maxTopics: number;
	debounceMs: number;
}

/** How long the master's permission request waits for the user before it is denied. */
const PERMISSION_TIMEOUT_MS = 10 * 60_000;

/** A chat turn with no output for this long is hung: its process is killed and restarted (ADR 0046). */
export const CHAT_HANG_MS = 5 * 60_000;
/** Waits before each restart of a chat that died mid-turn; after the last, it gives up. */
export const CHAT_RESTART_BACKOFF_MS = [1_000, 5_000, 30_000];
/** How long one of serenity's tools may run before the chat is told it timed out. */
export const TOOL_TIMEOUT_MS = 2 * 60_000;

interface Chat {
	process: ChatProcess;
	/** Started with --resume; one that exits before it says its session failed to resume. */
	resumed: boolean;
	/** The process named its Claude session (init). */
	started: boolean;
	/** A turn is running: the outbox's first message was sent and has no result yet. */
	thinking: boolean;
	reply: string[];
	/** Kills a turn that goes quiet for CHAT_HANG_MS. */
	watchdog: ReturnType<typeof setTimeout> | null;
}

/** A repo's chat that died mid-turn: how often it was restarted, and the pending restart. */
interface Restart {
	attempts: number;
	timer: ReturnType<typeof setTimeout> | null;
}

/** A master send a session has not answered yet (ADR 0039). */
interface Awaiting {
	repo: string;
	/** Sent while it worked: Claude may read it in that turn or queue it for the next. */
	queued: boolean;
	/** After a queued send's turn ends: pings unless a new turn starts first. */
	timer: ReturnType<typeof setTimeout> | null;
}

/** How long the map keeps a ping; it pulses for less. */
const PING_KEEP_MS = 5_000;
/** After a turn ends, how long a message queued during it has to start the next one. */
const QUEUE_GRACE_MS = 2_000;

interface PendingPermission {
	permission: MasterPermission;
	resolve: (allow: boolean) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * The master (ADR 0007): Haiku summaries and Sonnet suggestions as debounced
 * one-shot jobs per session, and an Opus chat per repo that starts on the
 * user's first message. It only proposes; the daemon executes on `y`.
 */
export class MasterSupervisor {
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly running = new Map<string, number>();
	private readonly errors = new Map<string, string>();
	private readonly chats = new Map<string, Chat>();
	/** repo → what outlives the daemon: chat session, watches, released Slack, outbox (ADR 0046). */
	private readonly records = new Map<string, MasterRecord>();
	private readonly restarts = new Map<string, Restart>();
	/** repo → serenity tool calls running now; a chat waiting on one is not hung. */
	private readonly toolCalls = new Map<string, number>();
	private readonly pending = new Map<string, PendingPermission>();
	/** session id → a master send it has not answered. */
	private readonly awaiting = new Map<string, Awaiting>();
	/** repo → recent pings, oldest first. */
	private readonly pingLog = new Map<string, Ping[]>();

	constructor(
		private readonly host: MasterHost,
		private readonly runner: ClaudeRunner,
	) {
		for (const record of host.storage.master.listAll())
			this.records.set(record.repo, record);
	}

	/** Delivers what the outbox held when the daemon last stopped. */
	start(): void {
		for (const record of this.records.values())
			if (record.outbox.length) {
				this.host.log(
					`master for ${record.repo} has ${record.outbox.length} message(s) to deliver`,
				);
				this.pump(record.repo);
			}
	}

	state(repo: string): MasterState {
		const busy =
			(this.running.get(repo) ?? 0) > 0 ||
			!!this.chats.get(repo)?.thinking ||
			!!this.restarts.get(repo)?.timer;
		return {
			status: busy ? "thinking" : "idle",
			error: this.errors.get(repo) ?? null,
		};
	}

	permissions(repo: string): MasterPermission[] {
		return [...this.pending.values()]
			.map((p) => p.permission)
			.filter((p) => p.repo === repo);
	}

	/** Messages between the master and sessions in the last few seconds (ADR 0039). */
	pings(repo: string): Ping[] {
		const since = this.host.now() - PING_KEEP_MS;
		return (this.pingLog.get(repo) ?? []).filter((p) => p.at >= since);
	}

	private ping(repo: string, sessionId: string, to: Ping["to"]): void {
		this.pingLog.set(repo, [
			...this.pings(repo),
			{ sessionId, to, at: this.host.now() },
		]);
		this.host.broadcast(repo);
	}

	/**
	 * Pings the master when a session answers a send_reply: its next turn
	 * end. A send to a working session may be read in that turn or queued
	 * for the next; a turn that starts soon after the end is the answer.
	 */
	private trackAnswer(before: Session | null, after: Session): void {
		const wait = this.awaiting.get(after.id);
		if (!wait || !before) return;
		const answered = () => {
			this.awaiting.delete(after.id);
			this.ping(wait.repo, after.id, "master");
		};
		if (after.status === "dead" || after.status === "archived") {
			if (wait.timer) clearTimeout(wait.timer);
			this.awaiting.delete(after.id);
		} else if (wait.timer && after.status === "working") {
			clearTimeout(wait.timer);
			wait.timer = null;
			wait.queued = false;
		} else if (turnEnded(before, after)) {
			if (wait.queued) wait.timer = setTimeout(answered, QUEUE_GRACE_MS);
			else answered();
		}
	}

	/** Called after every change to a session, with what it was before. */
	onSessionChanged(before: Session | null, after: Session): void {
		const replied =
			after.lastAssistantMessage &&
			after.lastAssistantMessage !== before?.lastAssistantMessage;
		if (replied)
			this.schedule("summary", after.id, () => this.summarize(after.id));
		if (["working", "dead", "archived"].includes(after.status))
			this.supersede(after.id);
		if (before && needsSuggestion(before, after))
			this.schedule("suggest", after.id, () => this.suggest(after.id));
		if (before && turnEnded(before, after)) this.fireWatch(after);
		this.trackAnswer(before, after);
	}

	/** Tells the chat a watched session's turn ended (ADR 0032). */
	private fireWatch(session: Session): void {
		const record = this.records.get(session.repo);
		const watch = record?.watches.find((w) => w.sessionId === session.id);
		if (!record || !watch) return;
		const finished = session.status === "idle" || session.status === "done";
		// Waiting on the user is not finished: it stays watched.
		if (session.status !== "waiting")
			record.watches = record.watches.filter((w) => w !== watch);
		if (watch.slack && finished) record.released.push(watch.slack);
		this.save(session.repo);
		this.host.log(`watch on ${session.name} fired (${session.status})`);
		this.tell(session.repo, watchMessage(session, watch.note, !!watch.slack));
	}

	private record(repo: string): MasterRecord {
		let record = this.records.get(repo);
		if (!record) {
			record = {
				repo,
				claudeSessionId: null,
				watches: [],
				released: [],
				outbox: [],
			};
			this.records.set(repo, record);
		}
		return record;
	}

	private save(repo: string): void {
		this.host.storage.master.put(this.record(repo));
	}

	// ------------------------------------------------------------ one-shot jobs

	private schedule(
		job: string,
		sessionId: string,
		run: () => Promise<void>,
	): void {
		const key = `${job}:${sessionId}`;
		clearTimeout(this.timers.get(key));
		this.timers.set(
			key,
			setTimeout(() => {
				this.timers.delete(key);
				void run();
			}, this.host.debounceMs),
		);
	}

	private async track(
		repo: string,
		what: string,
		work: () => Promise<void>,
	): Promise<void> {
		this.running.set(repo, (this.running.get(repo) ?? 0) + 1);
		this.host.broadcast(repo);
		try {
			await work();
			this.errors.delete(repo);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.errors.set(repo, `${what} failed: ${message}`);
			this.host.log(`${what} failed: ${message}`);
		} finally {
			this.running.set(repo, (this.running.get(repo) ?? 1) - 1);
			this.host.broadcast(repo);
		}
	}

	/**
	 * The repo's topics on the map, leaving out `except`'s own session. One
	 * whose sessions are all archived has left the map. Pinned sessions are
	 * drawn under the pinned topic, so theirs do not count.
	 */
	private topics(repo: string, except?: string): string[] {
		return [
			...new Set(
				this.host.storage.sessions
					.listByRepo(repo)
					.filter(
						(s) => s.status !== "archived" && !s.pinned && s.id !== except,
					)
					.map((s) => s.topic)
					.filter((c): c is string => !!c),
			),
		];
	}

	private async summarize(sessionId: string): Promise<void> {
		const session = this.host.storage.sessions.get(sessionId);
		if (!session?.lastAssistantMessage) return;
		const topics = this.topics(session.repo);
		const max = this.host.maxTopics;
		await this.track(session.repo, `summary of ${session.name}`, async () => {
			const raw = await this.runner.runJson({
				prompt: summaryPrompt(session, topics, max),
				model: this.host.models.summarizer,
				schema: summarySchema(topics, max),
				cwd: this.host.workerCwd,
			});
			const result = parseSummary(raw);
			if (!result) throw new Error("unusable summary");
			result.topic = capTopic(result.topic, this.topics(session.repo), max);
			const fresh = this.host.storage.sessions.get(sessionId);
			if (!fresh || fresh.status === "archived") return;
			const updated = this.host.update(fresh, applySummary(fresh, result));
			this.onSessionChanged(fresh, updated);
		});
	}

	private async suggest(sessionId: string): Promise<void> {
		const session = this.host.storage.sessions.get(sessionId);
		if (!session || (session.status !== "waiting" && session.status !== "done"))
			return;
		await this.track(
			session.repo,
			`suggestion for ${session.name}`,
			async () => {
				const raw = await this.runner.runJson({
					prompt: suggestionPrompt(session),
					model: this.host.models.suggester,
					schema: SUGGESTION_SCHEMA,
					cwd: this.host.workerCwd,
				});
				const fresh = this.host.storage.sessions.get(sessionId);
				// Only if nothing moved on while the model was thinking.
				if (
					!fresh ||
					fresh.status !== session.status ||
					fresh.ask !== session.ask
				)
					return;
				const result = parseSuggestion(raw, fresh);
				if (result)
					this.propose(fresh, result.kind, result.label, result.text, "worker");
			},
		);
	}

	// ------------------------------------------------------------- suggestions

	/** Pending suggestions of a session (or only those of `kind`) that no longer apply. */
	supersede(sessionId: string, kind?: SuggestionKind): void {
		const session = this.host.storage.sessions.get(sessionId);
		if (!session) return;
		let changed = false;
		for (const g of this.host.storage.suggestions.listPending(session.repo)) {
			if (g.sessionId !== sessionId || (kind && g.kind !== kind)) continue;
			this.host.storage.suggestions.put({
				...g,
				status: "superseded",
				updatedAt: this.host.now(),
			});
			changed = true;
		}
		if (changed) this.host.broadcast(session.repo);
	}

	/** Creates a pending suggestion, replacing the session's earlier ones. */
	propose(
		session: Session,
		kind: SuggestionKind,
		label: string,
		text: string | null,
		source: Suggestion["source"],
	): Suggestion {
		this.supersede(session.id);
		const at = this.host.now();
		const suggestion: Suggestion = {
			id: randomUUID(),
			repo: session.repo,
			sessionId: session.id,
			kind,
			label,
			text,
			status: "pending",
			source,
			createdAt: at,
			updatedAt: at,
		};
		this.host.storage.suggestions.put(suggestion);
		this.host.broadcast(session.repo);
		return suggestion;
	}

	// -------------------------------------------------------------------- chat

	message(repo: string, text: string): void {
		this.host.storage.conversation.append({
			repo,
			from: "you",
			text,
			at: this.host.now(),
		});
		this.enqueue(repo, { from: "you", text });
	}

	/** serenity's own message to the chat; never stored as the user's, so it confirms nothing. */
	private tell(repo: string, text: string): void {
		this.enqueue(repo, { from: "serenity", text });
	}

	private snapshot(repo: string): string {
		return chatSnapshot(
			this.host.storage.sessions.listByRepo(repo),
			this.host.storage.suggestions.listPending(repo),
			this.host.slack(repo)?.items ?? null,
		);
	}

	/**
	 * Every message to the chat goes through the repo's outbox (ADR 0046): it
	 * waits while a turn runs or the chat restarts, and survives the daemon.
	 */
	private enqueue(repo: string, item: MasterOutboxItem): void {
		this.record(repo).outbox.push(item);
		this.save(repo);
		this.host.broadcast(repo);
		this.pump(repo);
	}

	/** Sends the outbox's first message, unless a turn runs or a restart is pending. */
	private pump(repo: string): void {
		if (this.restarts.get(repo)?.timer) return;
		if (this.chats.get(repo)?.thinking) return;
		const item = this.records.get(repo)?.outbox[0];
		if (!item) return;
		let chat = this.chats.get(repo);
		try {
			chat ??= this.startChat(repo);
		} catch (error) {
			// e.g. the repo is gone; the message stays for the next try.
			const message = error instanceof Error ? error.message : String(error);
			this.errors.set(repo, `master could not start: ${message}`);
			this.host.log(`master chat for ${repo} could not start: ${message}`);
			this.host.broadcast(repo);
			return;
		}
		const snapshot = this.snapshot(repo);
		const body =
			item.from === "you"
				? chatMessage(snapshot, item.text)
				: `${snapshot}\n\n${item.text}`;
		const retry = this.restarts.get(repo)?.attempts
			? "serenity: your process restarted while answering the message below, so it is sent again. Tools you called for it may already have run: check session_status before calling one again.\n\n"
			: "";
		chat.thinking = true;
		chat.reply = [];
		this.arm(repo, chat);
		this.host.broadcast(repo);
		try {
			chat.process.send(`${retry}${body}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			chat.process.stop();
			this.ended(repo, chat, `master stopped (${message})`);
		}
	}

	/** (Re)starts the chat's hang timer; waiting on the user or on a serenity tool is not hanging. */
	private arm(repo: string, chat: Chat): void {
		if (chat.watchdog) clearTimeout(chat.watchdog);
		chat.watchdog = setTimeout(() => {
			chat.watchdog = null;
			if (this.chats.get(repo) !== chat || !chat.thinking) return;
			if (this.permissions(repo).length || this.toolCalls.get(repo)) {
				this.arm(repo, chat);
				return;
			}
			this.host.log(`master chat for ${repo} hung; restarting it`);
			chat.process.stop();
			this.ended(
				repo,
				chat,
				`master hung (no output for ${CHAT_HANG_MS / 60_000}m)`,
			);
		}, CHAT_HANG_MS);
	}

	private startChat(repo: string): Chat {
		const record = this.record(repo);
		const chat: Chat = {
			process: undefined as unknown as ChatProcess,
			resumed: !!record.claudeSessionId,
			started: false,
			thinking: false,
			reply: [],
			watchdog: null,
		};
		const slack = !!this.host.slack(repo);
		chat.process = this.runner.startChat(
			{
				cwd: repo,
				model: this.host.models.chat,
				mcpConfigPath: this.host.mcpConfig(repo),
				pluginDir: this.host.pluginDir,
				// Slack's read tools never ask; anything that writes asks the user.
				extraAllowed: slack ? SLACK_READ_TOOLS : [],
				systemPrompt: slack
					? `${MASTER_SYSTEM_PROMPT}\n${MASTER_SLACK_PROMPT}`
					: MASTER_SYSTEM_PROMPT,
				resume: record.claudeSessionId,
			},
			(event) => {
				// A chat that was replaced (hung, or failed to take a message) is ignored.
				if (this.chats.get(repo) !== chat) return;
				if (chat.thinking && event.type !== "exit") this.arm(repo, chat);
				if (event.type === "session") {
					chat.started = true;
					if (record.claudeSessionId !== event.sessionId) {
						record.claudeSessionId = event.sessionId;
						this.save(repo);
					}
				} else if (event.type === "text") {
					chat.reply.push(event.text);
				} else if (event.type === "result") {
					this.turnDone(repo, chat, event.isError, event.text);
				} else if (event.type === "exit") {
					this.ended(
						repo,
						chat,
						`master stopped (exit ${event.code}) ${event.stderr}`.trim(),
					);
				}
			},
		);
		this.chats.set(repo, chat);
		this.host.log(
			`master chat started for ${repo}${chat.resumed ? " (resumed)" : ""}`,
		);
		return chat;
	}

	private turnDone(
		repo: string,
		chat: Chat,
		isError: boolean,
		resultText: string,
	): void {
		if (chat.watchdog) clearTimeout(chat.watchdog);
		chat.watchdog = null;
		const text = chat.reply.join("\n\n") || resultText;
		if (text)
			this.host.storage.conversation.append({
				repo,
				from: "master",
				text,
				at: this.host.now(),
			});
		chat.reply = [];
		if (chat.thinking) {
			chat.thinking = false;
			this.record(repo).outbox.shift();
			this.save(repo);
		}
		this.restarts.delete(repo);
		if (isError) this.errors.set(repo, `master: ${resultText.slice(0, 120)}`);
		else this.errors.delete(repo);
		this.host.broadcast(repo);
		this.pump(repo);
	}

	/**
	 * The chat's process is gone (exited, hung or unwritable). A turn it was
	 * running is sent again to a restarted chat, up to one try per
	 * CHAT_RESTART_BACKOFF_MS; then that message is dropped and the rest wait
	 * for the next one (ADR 0046).
	 */
	private ended(repo: string, chat: Chat, why: string): void {
		if (this.chats.get(repo) !== chat) return;
		this.chats.delete(repo);
		if (chat.watchdog) clearTimeout(chat.watchdog);
		chat.watchdog = null;
		this.host.log(`master chat for ${repo} ended: ${why}`);
		// Its MCP server went with it, so nothing can answer these.
		for (const entry of [...this.pending.values()])
			if (entry.permission.repo === repo) entry.resolve(false);
		const record = this.record(repo);
		if (chat.resumed && !chat.started && record.claudeSessionId) {
			this.host.log(
				`master chat for ${repo} could not resume ${record.claudeSessionId}; the next starts fresh`,
			);
			record.claudeSessionId = null;
			this.save(repo);
		}
		if (!chat.thinking) {
			this.host.broadcast(repo);
			return;
		}
		chat.thinking = false;
		const attempts = (this.restarts.get(repo)?.attempts ?? 0) + 1;
		const wait = CHAT_RESTART_BACKOFF_MS[attempts - 1];
		if (wait === undefined) {
			const lost = record.outbox.shift();
			this.save(repo);
			this.restarts.delete(repo);
			this.errors.set(
				repo,
				`${why}; gave up after ${attempts - 1} restarts${lost?.from === "you" ? ", your message was not answered" : ""}`,
			);
			this.host.broadcast(repo);
			return;
		}
		this.errors.set(
			repo,
			`${why}; restarting (${attempts}/${CHAT_RESTART_BACKOFF_MS.length})`,
		);
		const restart: Restart = { attempts, timer: null };
		restart.timer = setTimeout(() => {
			restart.timer = null;
			this.pump(repo);
		}, wait);
		this.restarts.set(repo, restart);
		this.host.broadcast(repo);
	}

	// ---------------------------------------------------- tools from the chat

	/**
	 * One of serenity's tools, called by the chat through `serenity mcp`. It
	 * never throws, and anything but a permission request answers within
	 * TOOL_TIMEOUT_MS, so a stuck tmux or git call cannot stall the turn.
	 */
	async handleTool(
		repo: string,
		name: string,
		args: Record<string, unknown>,
	): Promise<MasterToolResult> {
		if (name === "request_permission")
			return this.requestPermission(repo, args);
		this.toolCalls.set(repo, (this.toolCalls.get(repo) ?? 0) + 1);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<MasterToolResult>((resolve) => {
			timer = setTimeout(
				() =>
					resolve({
						text: `${name} did not finish within ${TOOL_TIMEOUT_MS / 60_000} minutes; serenity stopped waiting, but it may still complete. Check session_status before calling it again.`,
						isError: true,
					}),
				TOOL_TIMEOUT_MS,
			);
		});
		try {
			return await Promise.race([this.runTool(repo, name, args), timeout]);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.host.log(`master tool ${name} failed: ${message}`);
			return { text: `${name} failed: ${message}`, isError: true };
		} finally {
			clearTimeout(timer);
			this.toolCalls.set(repo, (this.toolCalls.get(repo) ?? 1) - 1);
		}
	}

	private async runTool(
		repo: string,
		name: string,
		args: Record<string, unknown>,
	): Promise<MasterToolResult> {
		if (name === "session_status" && !args.session)
			return { text: this.snapshot(repo) };
		if (name === "create_session") return this.createSession(repo, args);
		const session = findSessionByName(
			this.host.storage.sessions.listByRepo(repo),
			args.session,
		);
		if (!session)
			return {
				text: `No session named ${String(args.session)}.`,
				isError: true,
			};

		if (name === "set_topic") {
			const topic = normalizeTopic(args.topic);
			if (!topic) return { text: "Give a topic name.", isError: true };
			if (session.pinned || topic === PINNED)
				return {
					text: "Only the user pins and unpins sessions, with p.",
					isError: true,
				};
			// Topics left once the session moves: a topic's last session may leave it.
			const topics = this.topics(repo, session.id);
			if (!capTopic(topic, topics, this.host.maxTopics))
				return {
					text: `There are already ${this.host.maxTopics} topics, the most allowed. Pick one of: ${topics.join(", ")}.`,
					isError: true,
				};
			this.host.update(session, { topic, topicCandidate: null });
			this.host.broadcast(repo);
			return { text: `Moved ${session.name} to ${topic}.` };
		}

		if (name === "archive_session") {
			if (session.status === "archived")
				return { text: `${session.name} is already archived.` };
			await this.host.kill(session);
			return { text: `Stopped and archived ${session.name}.` };
		}

		if (name === "session_status")
			return {
				text: sessionStatusText(
					session,
					this.host.storage.suggestions.listPending(repo),
					this.host.now(),
				),
			};

		if (name === "watch_session") return this.watch(repo, session, args);

		if (name === "open_session") {
			await this.host.open(session);
			return { text: `Opened ${session.name} beside the map.` };
		}

		if (name === "send_reply") return this.sendReply(repo, session, args);

		if (name === "suggest") {
			const kind = args.kind as SuggestionKind;
			const label =
				typeof args.label === "string" ? args.label.trim().slice(0, 60) : "";
			const text =
				typeof args.text === "string" && args.text.trim()
					? args.text.trim()
					: null;
			const problem = chatSuggestionProblem(session, kind, label, text);
			if (problem) return { text: problem, isError: true };
			this.propose(session, kind, label, text, "chat");
			return {
				text: `Shown to the user as "${label}". It runs only if they press y.`,
			};
		}
		return { text: `Unknown tool ${name}.`, isError: true };
	}

	private watch(
		repo: string,
		session: Session,
		args: Record<string, unknown>,
	): MasterToolResult {
		const record = this.record(repo);
		if (args.cancel === true) {
			const had = record.watches.some((w) => w.sessionId === session.id);
			record.watches = record.watches.filter((w) => w.sessionId !== session.id);
			this.save(repo);
			return {
				text: had
					? `Stopped watching ${session.name}.`
					: `${session.name} was not watched.`,
			};
		}
		if (session.status === "dead" || session.status === "archived")
			return { text: `${session.name} has ended.`, isError: true };
		const note = typeof args.note === "string" ? args.note.trim() : "";
		if (!note)
			return {
				text: "Say in note what to do when its turn ends.",
				isError: true,
			};
		const slack =
			typeof args.slack_text === "string" && args.slack_text.trim()
				? args.slack_text
				: null;
		// The same proof as a send in the chat (ADR 0030): the user's latest message answered the draft.
		if (
			slack &&
			!confirmedSlackSend(
				this.host.storage.conversation.listRecent(repo, 2),
				slack,
			)
		)
			return {
				text: "slack_text must be the exact message your last reply showed and the user just confirmed. Show the draft and ask first.",
				isError: true,
			};
		record.watches = [
			...record.watches.filter((w) => w.sessionId !== session.id),
			{ sessionId: session.id, note, slack },
		];
		this.save(repo);
		const now =
			session.status === "working"
				? "It is working now; serenity messages you when its turn ends."
				: `It is ${session.status} now, not working; serenity messages you when its next turn ends.`;
		return {
			text: `Watching ${session.name}. ${now}${slack ? " The confirmed Slack message goes out only once it finishes." : ""} End your turn now; don't wait or poll.`,
		};
	}

	/**
	 * The chat's send_reply (ADR 0035): a reply the user asked for in the chat,
	 * or to a session they @-mentioned in their latest message (ADR 0036), is
	 * typed into the session at once; any other text waits for `y` in NEEDS
	 * YOU, as suggest kind reply does.
	 */
	private async sendReply(
		repo: string,
		session: Session,
		args: Record<string, unknown>,
	): Promise<MasterToolResult> {
		const text = typeof args.text === "string" ? args.text.trim() : "";
		const full = `Reply "${text}"`;
		const label = full.length > 60 ? `${full.slice(0, 59)}…` : full;
		const problem = chatSuggestionProblem(
			session,
			"reply",
			label,
			text || null,
		);
		if (problem) return { text: problem, isError: true };
		const conversation = this.host.storage.conversation.listRecent(repo, 2);
		// An @mention of the session is the user's go-ahead for whatever text the master writes (ADR 0036).
		if (
			!mentionsSession(
				conversation,
				this.host.storage.sessions.listByRepo(repo),
				session,
			) &&
			!confirmedReply(conversation, text)
		) {
			this.propose(session, "reply", label, text, "chat");
			return {
				text: `The user did not ask for this exact text or @mention ${session.name}, so it waits in the master's queue as "${label}" and runs only if they press y. To send it now, show the exact text and ask; once they confirm, call send_reply again with it.`,
			};
		}
		try {
			await this.host.reply(session, text);
		} catch (error) {
			return {
				text: error instanceof Error ? error.message : String(error),
				isError: true,
			};
		}
		// It answers the session, so a reply waiting for y no longer applies.
		this.supersede(session.id);
		this.host.log(`master sent a confirmed reply to ${session.name}`);
		const earlier = this.awaiting.get(session.id);
		if (earlier?.timer) clearTimeout(earlier.timer);
		this.awaiting.set(session.id, {
			repo,
			queued: session.status === "working",
			timer: null,
		});
		this.ping(repo, session.id, "session");
		return {
			text:
				session.status === "working"
					? `Sent to ${session.name}. It is working; its agent reads it when this turn ends.`
					: `Sent to ${session.name}.`,
		};
	}

	/**
	 * The chat's create_session: a new worktree session started with the
	 * brief's prompt. Like N on the map, it runs at once; the user's request
	 * is the approval.
	 */
	private async createSession(
		repo: string,
		args: Record<string, unknown>,
	): Promise<MasterToolResult> {
		const name = typeof args.name === "string" ? args.name.trim() : "";
		const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
		if (!name) return { text: "Give the session a name.", isError: true };
		if (!prompt)
			return { text: "Give the session its first prompt.", isError: true };
		let topic: string | null = null;
		if (args.topic !== undefined && args.topic !== "") {
			topic = normalizeTopic(args.topic);
			if (topic === PINNED)
				return {
					text: "Only the user pins sessions, with p.",
					isError: true,
				};
			const topics = this.topics(repo);
			if (!capTopic(topic, topics, this.host.maxTopics))
				return {
					text: `There are already ${this.host.maxTopics} topics, the most allowed. Pick one of: ${topics.join(", ")}.`,
					isError: true,
				};
		}
		const session = await this.host.create({
			repo,
			name,
			cwd: repo,
			mode: "worktree",
			prompt,
		});
		if (topic) this.host.update(session, { topic, topicCandidate: null });
		this.host.broadcast(repo);
		return {
			text: `Started ${session.name} on branch ${session.branch}${topic ? ` under ${topic}` : ""}. It shows in your snapshot from now on.`,
		};
	}

	private requestPermission(
		repo: string,
		args: Record<string, unknown>,
	): Promise<MasterToolResult> {
		const input = (args.input ?? {}) as Record<string, unknown>;
		const toolName = String(args.tool_name ?? "a tool");
		// A Slack message the user just confirmed in the chat goes out (ADR 0030),
		// and so does one confirmed for a watched session that has finished (0032).
		if (
			toolName === SLACK_SEND_TOOL &&
			(confirmedSlackSend(
				this.host.storage.conversation.listRecent(repo, 2),
				input.message,
			) ||
				this.takeReleased(repo, input.message))
		) {
			this.host.log(`master sent a confirmed Slack message for ${repo}`);
			return Promise.resolve({
				text: JSON.stringify({ behavior: "allow", updatedInput: input }),
			});
		}
		const permission: MasterPermission = {
			id: randomUUID(),
			repo,
			toolName,
			detail: describeToolInput(input),
			at: this.host.now(),
		};
		return new Promise((resolve) => {
			const finish = (allow: boolean) => {
				const entry = this.pending.get(permission.id);
				if (!entry) return;
				clearTimeout(entry.timer);
				this.pending.delete(permission.id);
				this.host.broadcast(repo);
				resolve({
					text: JSON.stringify(
						allow
							? { behavior: "allow", updatedInput: input }
							: {
									behavior: "deny",
									message: "The user declined this in serenity.",
								},
					),
				});
			};
			const timer = setTimeout(() => finish(false), PERMISSION_TIMEOUT_MS);
			this.pending.set(permission.id, { permission, resolve: finish, timer });
			this.host.broadcast(repo);
		});
	}

	/** Uses up a released Slack message with this text; false if there is none. */
	private takeReleased(repo: string, message: unknown): boolean {
		const released = this.records.get(repo)?.released ?? [];
		const i = released.findIndex((text) => sameSlackText(text, message));
		if (i === -1) return false;
		released.splice(i, 1);
		this.save(repo);
		return true;
	}

	answerPermission(id: string, allow: boolean): boolean {
		const entry = this.pending.get(id);
		if (!entry) return false;
		entry.resolve(allow);
		return true;
	}

	stop(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		for (const wait of this.awaiting.values())
			if (wait.timer) clearTimeout(wait.timer);
		this.awaiting.clear();
		for (const restart of this.restarts.values())
			if (restart.timer) clearTimeout(restart.timer);
		this.restarts.clear();
		for (const entry of [...this.pending.values()]) entry.resolve(false);
		// Detached first, so their exits are not taken for crashes; the outbox stays for start().
		const chats = [...this.chats.values()];
		this.chats.clear();
		for (const chat of chats) {
			if (chat.watchdog) clearTimeout(chat.watchdog);
			chat.process.stop();
		}
	}
}

/** Why the chat's suggestion cannot apply to this session, or null if it can. */
export function chatSuggestionProblem(
	session: Session,
	kind: SuggestionKind,
	label: string,
	text: string | null,
): string | null {
	if (!label) return "Give the suggestion a short label.";
	if (kind === "reply") {
		if (!text) return "A reply needs the text to send.";
		if (session.status === "dead" || session.status === "archived")
			return `${session.name} has ended.`;
		if (session.waitingOn === "permission")
			return `${session.name} is waiting on a permission prompt; suggest approve instead.`;
		return null;
	}
	if (kind === "approve")
		return session.waitingOn === "permission"
			? null
			: `${session.name} is not waiting on a permission prompt.`;
	if (kind === "cleanup") {
		if (session.pinned)
			return `${session.name} is pinned for reuse; the user cleans it up with x.`;
		if (session.status === "working")
			return `${session.name} is still working.`;
		if (session.pr?.state === "OPEN")
			return `PR #${session.pr.number} is still open; clean up after it merges.`;
		return null;
	}
	if (kind === "review") {
		if (session.pr?.state !== "OPEN") return `${session.name} has no open PR.`;
		return text
			? null
			: "A review request needs the reviewer's GitHub login as text.";
	}
	return `Unknown kind ${String(kind)}; use reply, approve, cleanup or review.`;
}

/** One line for the master's permission request: the command, the path, or the input. */
export function describeToolInput(input: Record<string, unknown>): string {
	const pick = input.command ?? input.file_path ?? input.path ?? input.url;
	const text = typeof pick === "string" ? pick : JSON.stringify(input);
	return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

/**
 * Writes the plugin that gives the master chat its `serenity` skill
 * (ADR 0030); `--setting-sources ""` loads no other skills.
 */
export function writeMasterPlugin(dir: string): void {
	mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
	mkdirSync(join(dir, "skills", "serenity"), { recursive: true });
	writeFileSync(
		join(dir, ".claude-plugin", "plugin.json"),
		`${JSON.stringify({ name: "serenity-master", description: "The serenity master's skill.", version: "1" }, null, 2)}\n`,
	);
	writeFileSync(join(dir, "skills", "serenity", "SKILL.md"), MASTER_SKILL);
}

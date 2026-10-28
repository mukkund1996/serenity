import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	applySummary,
	type CreateSessionParams,
	capTopic,
	chatMessage,
	chatSnapshot,
	confirmedSlackSend,
	MASTER_SLACK_PROMPT,
	MASTER_SYSTEM_PROMPT,
	type MasterPermission,
	type MasterState,
	type MasterToolResult,
	needsSuggestion,
	normalizeTopic,
	PINNED,
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

interface Chat {
	process: ChatProcess;
	claudeSessionId: string | null;
	thinking: boolean;
	reply: string[];
	/** serenity's own messages (a watch fired) held until the current turn ends. */
	queued: string[];
}

/** A session the chat asked to hear about when its turn ends (watch_session). */
interface Watch {
	repo: string;
	note: string;
	/** A Slack message the user confirmed, to go out once the session finishes. */
	slack: string | null;
}

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
	/** Claude session ids of chats that ended, to resume them. */
	private readonly chatSessions = new Map<string, string>();
	private readonly pending = new Map<string, PendingPermission>();
	/** session id → its watch. */
	private readonly watches = new Map<string, Watch>();
	/** repo → confirmed Slack messages released by a finished watch, each sent once. */
	private readonly released = new Map<string, string[]>();

	constructor(
		private readonly host: MasterHost,
		private readonly runner: ClaudeRunner,
	) {}

	state(repo: string): MasterState {
		const busy =
			(this.running.get(repo) ?? 0) > 0 || !!this.chats.get(repo)?.thinking;
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
	}

	/** Tells the chat a watched session's turn ended (ADR 0032). */
	private fireWatch(session: Session): void {
		const watch = this.watches.get(session.id);
		if (!watch) return;
		const finished = session.status === "idle" || session.status === "done";
		// Waiting on the user is not finished: it stays watched.
		if (session.status !== "waiting") this.watches.delete(session.id);
		if (watch.slack && finished)
			this.released.set(watch.repo, [
				...(this.released.get(watch.repo) ?? []),
				watch.slack,
			]);
		this.host.log(`watch on ${session.name} fired (${session.status})`);
		this.tell(watch.repo, watchMessage(session, watch.note, !!watch.slack));
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
		this.send(repo, chatMessage(this.snapshot(repo), text));
	}

	/** serenity's own message to the chat; never stored as the user's, so it confirms nothing. */
	private tell(repo: string, text: string): void {
		const chat = this.chats.get(repo);
		if (chat?.thinking) chat.queued.push(text);
		else this.send(repo, `${this.snapshot(repo)}\n\n${text}`);
	}

	private snapshot(repo: string): string {
		return chatSnapshot(
			this.host.storage.sessions.listByRepo(repo),
			this.host.storage.suggestions.listPending(repo),
			this.host.slack(repo)?.items ?? null,
		);
	}

	private send(repo: string, text: string): void {
		const chat = this.chats.get(repo) ?? this.startChat(repo);
		chat.thinking = true;
		chat.reply = [];
		chat.process.send(text);
		this.host.broadcast(repo);
	}

	private startChat(repo: string): Chat {
		const chat: Chat = {
			process: undefined as unknown as ChatProcess,
			claudeSessionId: this.chatSessions.get(repo) ?? null,
			thinking: false,
			reply: [],
			queued: [],
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
				resume: chat.claudeSessionId,
			},
			(event) => {
				if (event.type === "session") {
					chat.claudeSessionId = event.sessionId;
					this.chatSessions.set(repo, event.sessionId);
				} else if (event.type === "text") {
					chat.reply.push(event.text);
				} else if (event.type === "result") {
					const text = chat.reply.join("\n\n") || event.text;
					if (text)
						this.host.storage.conversation.append({
							repo,
							from: "master",
							text,
							at: this.host.now(),
						});
					chat.thinking = false;
					chat.reply = [];
					if (event.isError)
						this.errors.set(repo, `master: ${event.text.slice(0, 120)}`);
					else this.errors.delete(repo);
					this.host.broadcast(repo);
					const next = chat.queued.shift();
					if (next) this.tell(repo, next);
				} else if (event.type === "exit") {
					if (this.chats.get(repo) !== chat) return;
					this.chats.delete(repo);
					if (chat.thinking)
						this.errors.set(
							repo,
							`master stopped (exit ${event.code}) ${event.stderr}`.trim(),
						);
					chat.thinking = false;
					this.host.log(`master chat for ${repo} exited (${event.code})`);
					this.host.broadcast(repo);
					// A fresh chat (resumed) still hears what was held.
					for (const text of chat.queued.splice(0)) this.tell(repo, text);
				}
			},
		);
		this.chats.set(repo, chat);
		this.host.log(
			`master chat started for ${repo}${chat.claudeSessionId ? " (resumed)" : ""}`,
		);
		return chat;
	}

	// ---------------------------------------------------- tools from the chat

	async handleTool(
		repo: string,
		name: string,
		args: Record<string, unknown>,
	): Promise<MasterToolResult> {
		if (name === "request_permission")
			return this.requestPermission(repo, args);
		if (name === "session_status" && !args.session)
			return { text: this.snapshot(repo) };
		if (name === "create_session") return this.createSession(repo, args);
		const session = this.host.storage.sessions
			.listByRepo(repo)
			.find((s) => s.name === args.session);
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
		if (args.cancel === true) {
			const had = this.watches.delete(session.id);
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
		this.watches.set(session.id, { repo, note, slack });
		const now =
			session.status === "working"
				? "It is working now; serenity messages you when its turn ends."
				: `It is ${session.status} now, not working; serenity messages you when its next turn ends.`;
		return {
			text: `Watching ${session.name}. ${now}${slack ? " The confirmed Slack message goes out only once it finishes." : ""} End your turn now; don't wait or poll.`,
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
		const released = this.released.get(repo) ?? [];
		const i = released.findIndex((text) => sameSlackText(text, message));
		if (i === -1) return false;
		released.splice(i, 1);
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
		for (const entry of this.pending.values()) entry.resolve(false);
		for (const chat of this.chats.values()) chat.process.stop();
		this.chats.clear();
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

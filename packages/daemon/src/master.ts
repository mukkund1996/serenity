import { randomUUID } from "node:crypto";
import {
	applySummary,
	chatMessage,
	chatSnapshot,
	MASTER_SYSTEM_PROMPT,
	type MasterPermission,
	type MasterState,
	type MasterToolResult,
	needsSuggestion,
	normalizeCategory,
	parseSuggestion,
	parseSummary,
	type Session,
	type Storage,
	SUGGESTION_SCHEMA,
	SUMMARY_SCHEMA,
	type Suggestion,
	type SuggestionKind,
	suggestionPrompt,
	summaryPrompt,
} from "@serenity/core";
import type { ChatProcess, ClaudeRunner } from "./claude";

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
	/** `--mcp-config` JSON for a repo's chat; its server is `serenity mcp <repo>`. */
	mcpConfig(repo: string): string;
	/** Where one-shot workers run; not the user's repo, so nothing there is loaded. */
	workerCwd: string;
	models: MasterModels;
	debounceMs: number;
}

/** How long the master's permission request waits for the user before it is denied. */
const PERMISSION_TIMEOUT_MS = 10 * 60_000;

interface Chat {
	process: ChatProcess;
	claudeSessionId: string | null;
	thinking: boolean;
	reply: string[];
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

	private async summarize(sessionId: string): Promise<void> {
		const session = this.host.storage.sessions.get(sessionId);
		if (!session?.lastAssistantMessage) return;
		const categories = [
			...new Set(
				this.host.storage.sessions
					.listByRepo(session.repo)
					.map((s) => s.category)
					.filter((c): c is string => !!c),
			),
		];
		await this.track(session.repo, `summary of ${session.name}`, async () => {
			const raw = await this.runner.runJson({
				prompt: summaryPrompt(session, categories),
				model: this.host.models.summarizer,
				schema: SUMMARY_SCHEMA,
				cwd: this.host.workerCwd,
			});
			const result = parseSummary(raw);
			if (!result) throw new Error("unusable summary");
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

	/** Pending suggestions of a session that a newer one replaces. */
	supersede(sessionId: string): void {
		const session = this.host.storage.sessions.get(sessionId);
		if (!session) return;
		let changed = false;
		for (const g of this.host.storage.suggestions.listPending(session.repo)) {
			if (g.sessionId !== sessionId) continue;
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
		const chat = this.chats.get(repo) ?? this.startChat(repo);
		chat.thinking = true;
		chat.reply = [];
		const snapshot = chatSnapshot(
			this.host.storage.sessions.listByRepo(repo),
			this.host.storage.suggestions.listPending(repo),
		);
		chat.process.send(chatMessage(snapshot, text));
		this.host.broadcast(repo);
	}

	private startChat(repo: string): Chat {
		const chat: Chat = {
			process: undefined as unknown as ChatProcess,
			claudeSessionId: this.chatSessions.get(repo) ?? null,
			thinking: false,
			reply: [],
		};
		chat.process = this.runner.startChat(
			{
				cwd: repo,
				model: this.host.models.chat,
				mcpConfigPath: this.host.mcpConfig(repo),
				systemPrompt: MASTER_SYSTEM_PROMPT,
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
		const session = this.host.storage.sessions
			.listByRepo(repo)
			.find((s) => s.name === args.session);
		if (!session)
			return {
				text: `No session named ${String(args.session)}.`,
				isError: true,
			};

		if (name === "set_category") {
			const category = normalizeCategory(args.category);
			if (!category) return { text: "Give a category name.", isError: true };
			this.host.update(session, { category, categoryCandidate: null });
			this.host.broadcast(repo);
			return { text: `Moved ${session.name} to ${category}.` };
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

	private requestPermission(
		repo: string,
		args: Record<string, unknown>,
	): Promise<MasterToolResult> {
		const input = (args.input ?? {}) as Record<string, unknown>;
		const permission: MasterPermission = {
			id: randomUUID(),
			repo,
			toolName: String(args.tool_name ?? "a tool"),
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

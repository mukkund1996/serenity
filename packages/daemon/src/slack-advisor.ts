import {
	parseSlackSuggestion,
	type ReviewRequest,
	type Session,
	SLACK_READ_TOOLS,
	SLACK_SEND_SCHEMA,
	SLACK_SEND_TOOL,
	SLACK_SUGGESTION_SCHEMA,
	type SlackAnswer,
	type SlackItem,
	type SlackSuggestion,
	type Storage,
	slackContext,
	slackSendPrompt,
	slackSuggestionPrompt,
} from "@serenity/core";
import type { ClaudeRunner } from "./claude";

export interface AdvisorHost {
	runner: ClaudeRunner;
	storage: Storage;
	/** Writes the suggestions (Sonnet). */
	model: string;
	/** Posts an accepted reply (Haiku). */
	sendModel: string;
	cwd: string;
	/** `--mcp-config` JSON holding only the Slack server. */
	mcpConfig: string;
	reviews(repo: string): ReviewRequest[];
	/** Types text into a session's agent, as a reply does. */
	sendText(session: Session, text: string): Promise<void>;
	/** Reads Slack again, so an answered item leaves the inbox. */
	refreshInbox(): void;
	broadcast(repo: string): void;
	log(line: string): void;
}

/** A suggestion, and the message it was made for: a newer one in the thread asks again. */
interface Entry {
	suggestion: SlackSuggestion;
	ts: string;
	/** For an asked session: the question, and its last reply when asked. */
	asked?: { question: string; before: string | null };
}

/** Reading a thread and writing a reply takes several tool calls. */
const SUGGEST_TIMEOUT_MS = 180_000;

/**
 * The master's suggestions for Slack (ADR 0024). For each item waiting on
 * the user, Sonnet reads the thread and, from what serenity knows (sessions,
 * archived ones too, their PRs, review requests), proposes a reply or a
 * question for a session. An asked session's next answer brings a reply.
 * Nothing runs until the user presses y. Kept in memory: a restart
 * suggests again from the next read.
 */
export class SlackAdvisor {
	/** repo → item id → its suggestion. */
	private readonly repos = new Map<string, Map<string, Entry>>();
	/** repo → the items of the last read. */
	private readonly items = new Map<string, SlackItem[]>();
	/** `repo|item|ts` the user declined or answered, so they are not suggested again. */
	private readonly settled = new Set<string>();
	private readonly running = new Set<string>();

	constructor(private readonly host: AdvisorHost) {}

	list(repo: string): SlackSuggestion[] {
		return [...(this.repos.get(repo)?.values() ?? [])].map((e) => e.suggestion);
	}

	/** A new read of Slack, for a repo whose map is open. */
	onInbox(repo: string, items: SlackItem[]): void {
		this.items.set(repo, items);
		const entries = this.entries(repo);
		let dropped = false;
		for (const [id, entry] of entries) {
			const item = items.find((i) => i.id === id);
			// Answered elsewhere, or someone wrote again: the old suggestion no longer fits.
			if (
				!item ||
				(item.ts !== entry.ts && entry.suggestion.status === "pending")
			) {
				entries.delete(id);
				dropped = true;
			}
		}
		if (dropped) this.host.broadcast(repo);
		for (const item of items)
			if (!entries.has(item.id) && !this.settled.has(key(repo, item)))
				void this.suggest(repo, item, null);
	}

	/** An asked session replied: turn its answer into a reply. */
	onSessionChanged(session: Session): void {
		const entries = this.repos.get(session.repo);
		if (!entries) return;
		for (const entry of entries.values()) {
			const { suggestion, asked } = entry;
			if (
				suggestion.status !== "asked" ||
				suggestion.sessionId !== session.id ||
				!asked ||
				!session.lastAssistantMessage ||
				session.lastAssistantMessage === asked.before
			)
				continue;
			const item = this.items
				.get(session.repo)
				?.find((i) => i.id === suggestion.itemId);
			if (!item) continue;
			void this.suggest(session.repo, item, {
				session: session.name,
				question: asked.question,
				answer: session.lastAssistantMessage,
			});
		}
	}

	private entries(repo: string): Map<string, Entry> {
		let entries = this.repos.get(repo);
		if (!entries) {
			entries = new Map();
			this.repos.set(repo, entries);
		}
		return entries;
	}

	private async suggest(
		repo: string,
		item: SlackItem,
		answer: SlackAnswer | null,
	): Promise<void> {
		const job = `${repo}|${item.id}`;
		if (this.running.has(job)) return;
		this.running.add(job);
		try {
			const sessions = this.host.storage.sessions.listByRepo(repo);
			const raw = await this.host.runner.runJson({
				prompt: slackSuggestionPrompt(
					item,
					slackContext(sessions, this.host.reviews(repo)),
					answer,
				),
				model: this.host.model,
				schema: SLACK_SUGGESTION_SCHEMA,
				cwd: this.host.cwd,
				mcpConfig: this.host.mcpConfig,
				allowedTools: SLACK_READ_TOOLS,
				timeoutMs: SUGGEST_TIMEOUT_MS,
			});
			// Gone from the inbox while the model was thinking.
			if (!this.items.get(repo)?.some((i) => i.id === item.id)) return;
			const fresh = this.host.storage.sessions.listByRepo(repo);
			const suggestion = parseSlackSuggestion(raw, item, fresh, !!answer);
			const entries = this.entries(repo);
			if (suggestion) entries.set(item.id, { suggestion, ts: item.ts });
			else entries.delete(item.id);
			this.host.broadcast(repo);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.host.log(`slack suggestion for ${item.id} failed: ${message}`);
		} finally {
			this.running.delete(job);
		}
	}

	/** y: post the reply, or type the question to the session. `text` is the user's edit (e). */
	async accept(repo: string, itemId: string, text?: string): Promise<void> {
		const entry = this.repos.get(repo)?.get(itemId);
		const item = this.items.get(repo)?.find((i) => i.id === itemId);
		if (!entry || !item || entry.suggestion.status !== "pending")
			throw new Error("that suggestion is no longer pending");
		const body = (text ?? entry.suggestion.text).trim();
		if (!body) throw new Error("nothing to send");
		const { suggestion } = entry;

		if (suggestion.kind === "ask") {
			const session = suggestion.sessionId
				? this.host.storage.sessions.get(suggestion.sessionId)
				: null;
			if (!session) throw new Error("that session is gone");
			await this.host.sendText(session, body);
			entry.asked = { question: body, before: session.lastAssistantMessage };
			entry.suggestion = {
				...suggestion,
				text: body,
				label: `Asked ${session.name}; waiting for its answer`,
				status: "asked",
			};
			this.host.broadcast(repo);
			return;
		}

		entry.suggestion = { ...suggestion, text: body, status: "sending" };
		this.host.broadcast(repo);
		try {
			const raw = (await this.host.runner.runJson({
				prompt: slackSendPrompt(item, body),
				model: this.host.sendModel,
				schema: SLACK_SEND_SCHEMA,
				cwd: this.host.cwd,
				mcpConfig: this.host.mcpConfig,
				allowedTools: [SLACK_SEND_TOOL],
			})) as { sent?: boolean; problem?: string | null };
			if (!raw?.sent)
				throw new Error(`Slack did not take it: ${raw?.problem ?? "unknown"}`);
		} catch (error) {
			entry.suggestion = { ...suggestion, text: body };
			this.host.broadcast(repo);
			throw error;
		}
		this.settled.add(key(repo, item));
		this.repos.get(repo)?.delete(itemId);
		this.host.broadcast(repo);
		this.host.refreshInbox();
	}

	/** n: drop it; the item is not suggested again until someone writes in its thread. */
	decline(repo: string, itemId: string): void {
		const item = this.items.get(repo)?.find((i) => i.id === itemId);
		if (item) this.settled.add(key(repo, item));
		if (this.repos.get(repo)?.delete(itemId)) this.host.broadcast(repo);
	}
}

function key(repo: string, item: SlackItem): string {
	return `${repo}|${item.id}|${item.ts}`;
}

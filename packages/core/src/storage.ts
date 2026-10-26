import type {
	HookEvent,
	HookKind,
	HookPayload,
	MasterMessage,
	Session,
	Suggestion,
	Wait,
} from "./domain";

/**
 * Storage interfaces (ADR 0009). They speak domain types only, so a backend
 * can be swapped by implementing them and passing the shared contract suite
 * in `@serenity/core/testing`.
 */
export interface SessionStore {
	get(id: string): Session | null;
	listByRepo(repo: string): Session[];
	listAll(): Session[];
	/** Inserts or replaces the whole session. */
	put(session: Session): void;
	delete(id: string): void;
}

export interface NewHookEvent {
	sessionId: string;
	kind: HookKind;
	payload: HookPayload;
	at: number;
}

export interface EventStore {
	append(event: NewHookEvent): HookEvent;
	/** Newest first. */
	listForSession(sessionId: string, limit: number): HookEvent[];
}

export interface SuggestionStore {
	get(id: string): Suggestion | null;
	/** Inserts or replaces the whole suggestion. */
	put(suggestion: Suggestion): void;
	/** Pending suggestions of a repo, oldest first. */
	listPending(repo: string): Suggestion[];
}

export type NewMasterMessage = Omit<MasterMessage, "id">;

export interface ConversationStore {
	append(message: NewMasterMessage): MasterMessage;
	/** The newest `limit` messages of a repo, oldest first. */
	listRecent(repo: string, limit: number): MasterMessage[];
}

export interface WaitStore {
	append(wait: Wait): void;
	/** A repo's waits that ended at or after `since`, oldest first. */
	listSince(repo: string, since: number): Wait[];
}

export interface Storage {
	readonly sessions: SessionStore;
	readonly events: EventStore;
	readonly suggestions: SuggestionStore;
	readonly conversation: ConversationStore;
	readonly waits: WaitStore;
	/** Runs `fn` atomically; nested calls join the outer transaction. */
	transaction<T>(fn: () => T): T;
	close(): void;
}

export function createMemoryStorage(): Storage {
	const sessions = new Map<string, Session>();
	const events: HookEvent[] = [];
	const suggestions = new Map<string, Suggestion>();
	const messages: MasterMessage[] = [];
	const waits: Wait[] = [];
	let nextEventId = 1;
	let nextMessageId = 1;

	return {
		sessions: {
			get: (id) => {
				const s = sessions.get(id);
				return s ? { ...s } : null;
			},
			listByRepo: (repo) =>
				[...sessions.values()]
					.filter((s) => s.repo === repo)
					.sort((a, b) => a.createdAt - b.createdAt)
					.map((s) => ({ ...s })),
			listAll: () =>
				[...sessions.values()]
					.sort((a, b) => a.createdAt - b.createdAt)
					.map((s) => ({ ...s })),
			put: (session) => {
				sessions.set(session.id, { ...session });
			},
			delete: (id) => {
				sessions.delete(id);
			},
		},
		events: {
			append: (event) => {
				const stored = { ...event, id: nextEventId++ };
				events.push(stored);
				return stored;
			},
			listForSession: (sessionId, limit) =>
				events
					.filter((e) => e.sessionId === sessionId)
					.reverse()
					.slice(0, limit),
		},
		suggestions: {
			get: (id) => {
				const s = suggestions.get(id);
				return s ? { ...s } : null;
			},
			put: (suggestion) => {
				suggestions.set(suggestion.id, { ...suggestion });
			},
			listPending: (repo) =>
				[...suggestions.values()]
					.filter((s) => s.repo === repo && s.status === "pending")
					.sort((a, b) => a.createdAt - b.createdAt)
					.map((s) => ({ ...s })),
		},
		conversation: {
			append: (message) => {
				const stored = { ...message, id: nextMessageId++ };
				messages.push(stored);
				return { ...stored };
			},
			listRecent: (repo, limit) =>
				messages
					.filter((m) => m.repo === repo)
					.slice(-limit)
					.map((m) => ({ ...m })),
		},
		waits: {
			append: (wait) => {
				waits.push({ ...wait });
			},
			listSince: (repo, since) =>
				waits
					.filter((w) => w.repo === repo && w.endedAt >= since)
					.sort((a, b) => a.endedAt - b.endedAt)
					.map((w) => ({ ...w })),
		},
		transaction: (fn) => fn(),
		close: () => {},
	};
}

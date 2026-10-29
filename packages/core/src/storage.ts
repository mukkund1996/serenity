import type {
	HookEvent,
	HookKind,
	HookPayload,
	MasterMessage,
	Session,
	Suggestion,
	Usage,
	Wait,
} from "./domain";
import { type SlackDismissal, slackMessageKey } from "./slack";

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

export interface SlackDismissalStore {
	/** Records a dismissal; the same message again is a no-op. */
	add(dismissal: SlackDismissal): void;
	/** Every dismissal, oldest first. */
	list(): SlackDismissal[];
}

/** A session joined beside a repo's map, or an adopted one its client was switched to. */
export interface Attachment {
	repo: string;
	sessionId: string;
	clientPane: string;
	/** For an adopted session: the tmux client switched to it. */
	clientTty?: string;
}

/**
 * What the daemon would otherwise hold only in memory, kept so a restart
 * after a crash picks up where it left off (ADR 0044).
 */
export interface RecoveryState {
	/** The latest plan usage report (ADR 0020). */
	usage: Usage;
	/** Sessions attached beside a map, one per repo. */
	attached: Attachment[];
	/** `session:pr` pairs already offered a reviewer, so a decline sticks. */
	offeredReviews: string[];
}

export interface RecoveryStore {
	get<K extends keyof RecoveryState>(key: K): RecoveryState[K] | null;
	/** Replaces the value; null removes it. */
	set<K extends keyof RecoveryState>(
		key: K,
		value: RecoveryState[K] | null,
	): void;
}

export interface Storage {
	readonly sessions: SessionStore;
	readonly events: EventStore;
	readonly suggestions: SuggestionStore;
	readonly conversation: ConversationStore;
	readonly waits: WaitStore;
	/** Slack messages dismissed from NEEDS YOU; per account, not per repo (ADR 0034). */
	readonly slackDismissals: SlackDismissalStore;
	/** In-memory daemon state that must survive a restart (ADR 0044). */
	readonly recovery: RecoveryStore;
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
	const dismissals = new Map<string, SlackDismissal>();
	const recovery = new Map<string, string>();
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
		slackDismissals: {
			add: (d) => {
				const key = slackMessageKey(d);
				if (!dismissals.has(key)) dismissals.set(key, { ...d });
			},
			list: () =>
				[...dismissals.values()]
					.sort((a, b) => a.at - b.at)
					.map((d) => ({ ...d })),
		},
		recovery: {
			get: (key) => {
				const value = recovery.get(key);
				return value === undefined ? null : JSON.parse(value);
			},
			set: (key, value) => {
				if (value === null) recovery.delete(key);
				else recovery.set(key, JSON.stringify(value));
			},
		},
		transaction: (fn) => fn(),
		close: () => {},
	};
}

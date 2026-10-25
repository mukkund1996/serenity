import type { HookEvent, HookKind, HookPayload, Session } from "./domain";

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

export interface Storage {
	readonly sessions: SessionStore;
	readonly events: EventStore;
	/** Runs `fn` atomically; nested calls join the outer transaction. */
	transaction<T>(fn: () => T): T;
	close(): void;
}

export function createMemoryStorage(): Storage {
	const sessions = new Map<string, Session>();
	const events: HookEvent[] = [];
	let nextEventId = 1;

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
		transaction: (fn) => fn(),
		close: () => {},
	};
}

import { Database } from "bun:sqlite";
import type {
	HookEvent,
	HookKind,
	HookPayload,
	MasterMessage,
	Session,
	SlackDismissal,
	Storage,
	Suggestion,
	Wait,
} from "@serenity/core";

/** Forward-only migrations; index + 1 is the schema version (PRAGMA user_version). */
const MIGRATIONS = [
	`CREATE TABLE sessions (
		id TEXT PRIMARY KEY,
		repo TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		data TEXT NOT NULL
	);
	CREATE INDEX sessions_repo ON sessions (repo, created_at);
	CREATE TABLE events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		payload TEXT NOT NULL,
		at INTEGER NOT NULL
	);
	CREATE INDEX events_session ON events (session_id, id);`,
	`CREATE TABLE suggestions (
		id TEXT PRIMARY KEY,
		repo TEXT NOT NULL,
		status TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		data TEXT NOT NULL
	);
	CREATE INDEX suggestions_pending ON suggestions (repo, status, created_at);
	CREATE TABLE conversation (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		repo TEXT NOT NULL,
		sender TEXT NOT NULL,
		text TEXT NOT NULL,
		at INTEGER NOT NULL
	);
	CREATE INDEX conversation_repo ON conversation (repo, id);`,
	`CREATE TABLE waits (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		repo TEXT NOT NULL,
		session_id TEXT NOT NULL,
		started_at INTEGER NOT NULL,
		ended_at INTEGER NOT NULL
	);
	CREATE INDEX waits_repo ON waits (repo, ended_at);`,
	`CREATE TABLE slack_dismissals (
		channel_id TEXT NOT NULL,
		ts TEXT NOT NULL,
		at INTEGER NOT NULL,
		PRIMARY KEY (channel_id, ts)
	);`,
	`CREATE TABLE recovery (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);`,
];

/** Fields added after a session row may have been written; filled in on read. */
const SESSION_DEFAULTS: Pick<
	Session,
	| "waitingOn"
	| "waitingSince"
	| "ownsBranch"
	| "pr"
	| "prError"
	| "origin"
	| "tracking"
	| "claudePid"
	| "pinned"
	| "exitNote"
	| "subagents"
> = {
	waitingOn: null,
	waitingSince: null,
	ownsBranch: false,
	pr: null,
	prError: null,
	origin: "spawned",
	tracking: "hooks",
	claudePid: null,
	pinned: false,
	exitNote: null,
	subagents: [],
};

/** Rows written before "category" was renamed to "topic". */
type StoredSession = Omit<Session, "topic" | "topicCandidate"> &
	Partial<Pick<Session, "topic" | "topicCandidate">> & {
		category?: string | null;
		categoryCandidate?: string | null;
	};

function readSession(data: string): Session {
	const { category, categoryCandidate, ...row } = JSON.parse(
		data,
	) as StoredSession;
	return {
		...SESSION_DEFAULTS,
		...row,
		topic: row.topic ?? category ?? null,
		topicCandidate: row.topicCandidate ?? categoryCandidate ?? null,
	};
}

interface MessageRow {
	id: number;
	repo: string;
	sender: "you" | "master";
	text: string;
	at: number;
}

function migrate(db: Database): void {
	const row = db
		.query<{ user_version: number }, []>("PRAGMA user_version")
		.get();
	const current = row?.user_version ?? 0;
	for (let version = current; version < MIGRATIONS.length; version++) {
		db.transaction(() => {
			db.run(MIGRATIONS[version] as string);
			db.run(`PRAGMA user_version = ${version + 1}`);
		})();
	}
}

interface WaitRow {
	repo: string;
	session_id: string;
	started_at: number;
	ended_at: number;
}

interface DismissalRow {
	channel_id: string;
	ts: string;
	at: number;
}

interface EventRow {
	id: number;
	session_id: string;
	kind: string;
	payload: string;
	at: number;
}

export function createSqliteStorage(path: string): Storage {
	const db = new Database(path, { create: true, strict: true });
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA busy_timeout = 2000");
	migrate(db);

	const getSession = db.query<{ data: string }, [string]>(
		"SELECT data FROM sessions WHERE id = ?",
	);
	const listByRepo = db.query<{ data: string }, [string]>(
		"SELECT data FROM sessions WHERE repo = ? ORDER BY created_at, id",
	);
	const listAll = db.query<{ data: string }, []>(
		"SELECT data FROM sessions ORDER BY created_at, id",
	);
	const putSession = db.query<unknown, [string, string, number, string]>(
		"INSERT OR REPLACE INTO sessions (id, repo, created_at, data) VALUES (?, ?, ?, ?)",
	);
	const deleteSession = db.query<unknown, [string]>(
		"DELETE FROM sessions WHERE id = ?",
	);
	const insertEvent = db.query<
		{ id: number },
		[string, string, string, number]
	>(
		"INSERT INTO events (session_id, kind, payload, at) VALUES (?, ?, ?, ?) RETURNING id",
	);
	const listEvents = db.query<EventRow, [string, number]>(
		"SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?",
	);

	const getSuggestion = db.query<{ data: string }, [string]>(
		"SELECT data FROM suggestions WHERE id = ?",
	);
	const putSuggestion = db.query<
		unknown,
		[string, string, string, number, string]
	>(
		"INSERT OR REPLACE INTO suggestions (id, repo, status, created_at, data) VALUES (?, ?, ?, ?, ?)",
	);
	const listPending = db.query<{ data: string }, [string]>(
		"SELECT data FROM suggestions WHERE repo = ? AND status = 'pending' ORDER BY created_at, id",
	);
	const insertMessage = db.query<
		{ id: number },
		[string, string, string, number]
	>(
		"INSERT INTO conversation (repo, sender, text, at) VALUES (?, ?, ?, ?) RETURNING id",
	);
	const listMessages = db.query<MessageRow, [string, number]>(
		"SELECT * FROM (SELECT * FROM conversation WHERE repo = ? ORDER BY id DESC LIMIT ?) ORDER BY id",
	);

	const insertWait = db.query<unknown, [string, string, number, number]>(
		"INSERT INTO waits (repo, session_id, started_at, ended_at) VALUES (?, ?, ?, ?)",
	);
	const listWaits = db.query<WaitRow, [string, number]>(
		"SELECT * FROM waits WHERE repo = ? AND ended_at >= ? ORDER BY ended_at, id",
	);

	const insertDismissal = db.query<unknown, [string, string, number]>(
		"INSERT OR IGNORE INTO slack_dismissals (channel_id, ts, at) VALUES (?, ?, ?)",
	);
	const listDismissals = db.query<DismissalRow, []>(
		"SELECT * FROM slack_dismissals ORDER BY at, rowid",
	);

	const getRecovery = db.query<{ value: string }, [string]>(
		"SELECT value FROM recovery WHERE key = ?",
	);
	const putRecovery = db.query<unknown, [string, string]>(
		"INSERT OR REPLACE INTO recovery (key, value) VALUES (?, ?)",
	);
	const deleteRecovery = db.query<unknown, [string]>(
		"DELETE FROM recovery WHERE key = ?",
	);

	const parse = (row: { data: string } | null): Session | null =>
		row ? readSession(row.data) : null;

	let depth = 0;

	return {
		sessions: {
			get: (id) => parse(getSession.get(id)),
			listByRepo: (repo) =>
				listByRepo.all(repo).map((row) => readSession(row.data)),
			listAll: () => listAll.all().map((row) => readSession(row.data)),
			put: (session) => {
				putSession.run(
					session.id,
					session.repo,
					session.createdAt,
					JSON.stringify(session),
				);
			},
			delete: (id) => {
				deleteSession.run(id);
			},
		},
		events: {
			append: (event) => {
				const row = insertEvent.get(
					event.sessionId,
					event.kind,
					JSON.stringify(event.payload),
					event.at,
				);
				return { ...event, id: row?.id ?? 0 };
			},
			listForSession: (sessionId, limit) =>
				listEvents.all(sessionId, limit).map(
					(row): HookEvent => ({
						id: row.id,
						sessionId: row.session_id,
						kind: row.kind as HookKind,
						payload: JSON.parse(row.payload) as HookPayload,
						at: row.at,
					}),
				),
		},
		suggestions: {
			get: (id) => {
				const row = getSuggestion.get(id);
				return row ? (JSON.parse(row.data) as Suggestion) : null;
			},
			put: (g) => {
				putSuggestion.run(
					g.id,
					g.repo,
					g.status,
					g.createdAt,
					JSON.stringify(g),
				);
			},
			listPending: (repo) =>
				listPending.all(repo).map((row) => JSON.parse(row.data) as Suggestion),
		},
		conversation: {
			append: (m) => {
				const row = insertMessage.get(m.repo, m.from, m.text, m.at);
				return { ...m, id: row?.id ?? 0 };
			},
			listRecent: (repo, limit) =>
				listMessages.all(repo, limit).map(
					(row): MasterMessage => ({
						id: row.id,
						repo: row.repo,
						from: row.sender,
						text: row.text,
						at: row.at,
					}),
				),
		},
		waits: {
			append: (w) => {
				insertWait.run(w.repo, w.sessionId, w.startedAt, w.endedAt);
			},
			listSince: (repo, since) =>
				listWaits.all(repo, since).map(
					(row): Wait => ({
						repo: row.repo,
						sessionId: row.session_id,
						startedAt: row.started_at,
						endedAt: row.ended_at,
					}),
				),
		},
		slackDismissals: {
			add: (d) => {
				insertDismissal.run(d.channelId, d.ts, d.at);
			},
			list: () =>
				listDismissals.all().map(
					(row): SlackDismissal => ({
						channelId: row.channel_id,
						ts: row.ts,
						at: row.at,
					}),
				),
		},
		recovery: {
			get: (key) => {
				const row = getRecovery.get(key);
				return row ? JSON.parse(row.value) : null;
			},
			set: (key, value) => {
				if (value === null) deleteRecovery.run(key);
				else putRecovery.run(key, JSON.stringify(value));
			},
		},
		transaction: (fn) => {
			if (depth > 0) return fn();
			depth++;
			try {
				return db.transaction(fn)();
			} finally {
				depth--;
			}
		},
		close: () => db.close(),
	};
}

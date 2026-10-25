import { Database } from "bun:sqlite";
import type {
	HookEvent,
	HookKind,
	HookPayload,
	Session,
	Storage,
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
];

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

	const parse = (row: { data: string } | null): Session | null =>
		row ? (JSON.parse(row.data) as Session) : null;

	let depth = 0;

	return {
		sessions: {
			get: (id) => parse(getSession.get(id)),
			listByRepo: (repo) =>
				listByRepo.all(repo).map((row) => JSON.parse(row.data) as Session),
			listAll: () =>
				listAll.all().map((row) => JSON.parse(row.data) as Session),
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

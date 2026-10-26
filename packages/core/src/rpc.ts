import { connect as netConnect, type Socket } from "node:net";
import type {
	HookKind,
	HookPayload,
	ImportCandidate,
	RepoState,
	Session,
} from "./domain";

/**
 * JSON-RPC 2.0 over a unix socket, one JSON message per line (ADR 0005).
 * Both ends are an RpcPeer: the daemon answers requests and pushes
 * notifications; clients do the reverse.
 */

export type SessionMode = "worktree" | "branch";

export interface CreateSessionParams {
	repo: string;
	name: string;
	/** Directory to run in when mode is "branch" and the branch is already checked out there. */
	cwd: string;
	mode: SessionMode;
	/** Branch to create (worktree) or to check out (branch). Defaults to the name. */
	branch?: string;
	/** Sent to the agent as its first prompt. */
	prompt?: string;
}

/** What cleaning up a session would do, computed by serenity, not the model (ADR 0008). */
export interface CleanupPlan {
	/** Each step, e.g. "stop the session api-auth". */
	steps: string[];
	/** Facts that decide safety, e.g. "no uncommitted changes". */
	safety: string[];
	/** False when something would be lost; the UI then asks via the Confirm overlay. */
	safe: boolean;
}

/** A tool call from the master chat, forwarded by `serenity mcp`. */
export interface MasterToolResult {
	text: string;
	isError?: boolean;
}

export interface Methods {
	hello: {
		params: { clientVersion: string };
		result: { daemonVersion: string; pid: number };
	};
	/** clientPane: the map's tmux pane, where the master's open_session attaches. */
	"state.subscribe": {
		params: { repo: string; clientPane?: string };
		result: RepoState;
	};
	"session.create": { params: CreateSessionParams; result: Session };
	"session.reply": { params: { id: string; text: string }; result: null };
	"session.attach": {
		params: { id: string; clientPane: string };
		result: null;
	};
	/**
	 * Detach by the agent's pane (the tmux Ctrl+g binding), by session id, or
	 * whatever is attached beside a map pane (clientPane: the map is exiting).
	 */
	"session.detach": {
		params: { pane?: string; id?: string; clientPane?: string };
		result: null;
	};
	"hook.event": {
		params: { sessionId: string; kind: HookKind; payload: HookPayload };
		result: null;
	};
	/** Sent by the agent's wrapper shell when claude exits, for any reason. */
	"session.exited": {
		params: { sessionId: string; code: number | null };
		result: null;
	};
	/** Claude sessions running in tmux in this repo that the map does not track (ADR 0016). */
	"session.discover": { params: { repo: string }; result: ImportCandidate[] };
	"session.adopt": {
		params: { repo: string; claudeSessionIds: string[] };
		result: Session[];
	};
	/** Restarts an adopted session with `claude --resume` under serenity's hooks. */
	"session.upgrade": { params: { id: string }; result: null };
	/** Topics have no rename: only the master manages them (ADR 0012). */
	"session.rename": { params: { id: string; name: string }; result: Session };
	"session.watch": { params: { id: string; watched: boolean }; result: null };
	"session.pin": { params: { id: string; pinned: boolean }; result: null };
	"session.cleanupPlan": { params: { id: string }; result: CleanupPlan };
	"session.cleanup": { params: { id: string }; result: null };
	"session.kill": { params: { id: string }; result: null };
	/** Runs a pending suggestion; `text` overrides a reply's text (the e key). */
	"suggestion.accept": { params: { id: string; text?: string }; result: null };
	"suggestion.decline": { params: { id: string }; result: null };
	/** Claude's status line `rate_limits`, forwarded by `serenity statusline` (ADR 0020). */
	"usage.report": { params: { rateLimits: unknown }; result: null };
	"master.message": { params: { repo: string; text: string }; result: null };
	"master.permission": { params: { id: string; allow: boolean }; result: null };
	"master.tool": {
		params: { repo: string; name: string; args: Record<string, unknown> };
		result: MasterToolResult;
	};
	"daemon.shutdown": { params: Record<string, never>; result: null };
}

export interface Notifications {
	"state.changed": RepoState;
}

export type Method = keyof Methods;
export type Params<M extends Method> = Methods[M]["params"];
export type Result<M extends Method> = Methods[M]["result"];

export const RpcErrorCode = {
	ParseError: -32700,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	Internal: -32603,
	Timeout: -32000,
	Closed: -32001,
} as const;

export class RpcError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "RpcError";
	}
}

type Message =
	| { jsonrpc: "2.0"; id: number; method: string; params?: unknown }
	| { jsonrpc: "2.0"; method: string; params?: unknown }
	| { jsonrpc: "2.0"; id: number; result: unknown }
	| { jsonrpc: "2.0"; id: number; error: { code: number; message: string } };

type RequestHandler = (
	method: string,
	params: unknown,
) => Promise<unknown> | unknown;
type NotificationHandler = (method: string, params: unknown) => void;

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout> | null;
}

export class RpcPeer {
	private buffer = "";
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private requestHandler: RequestHandler | null = null;
	private notificationHandler: NotificationHandler | null = null;
	private readonly closeHandlers: Array<() => void> = [];
	private closed = false;

	constructor(private readonly socket: Socket) {
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => this.receive(chunk));
		socket.on("error", () => this.shutdown());
		socket.on("close", () => this.shutdown());
	}

	request<M extends Method>(
		method: M,
		params: Params<M>,
		opts: { timeoutMs?: number } = {},
	): Promise<Result<M>> {
		if (this.closed)
			return Promise.reject(
				new RpcError(RpcErrorCode.Closed, "connection closed"),
			);
		const id = this.nextId++;
		return new Promise<Result<M>>((resolve, reject) => {
			const timer = opts.timeoutMs
				? setTimeout(() => {
						this.pending.delete(id);
						reject(new RpcError(RpcErrorCode.Timeout, `${method} timed out`));
					}, opts.timeoutMs)
				: null;
			this.pending.set(id, {
				resolve: resolve as (v: unknown) => void,
				reject,
				timer,
			});
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify<N extends keyof Notifications>(
		method: N,
		params: Notifications[N],
	): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	onRequest(handler: RequestHandler): void {
		this.requestHandler = handler;
	}

	onNotification(handler: NotificationHandler): void {
		this.notificationHandler = handler;
	}

	onClose(handler: () => void): void {
		if (this.closed) handler();
		else this.closeHandlers.push(handler);
	}

	get isClosed(): boolean {
		return this.closed;
	}

	close(): void {
		this.socket.end();
		this.shutdown();
	}

	private send(message: Message): void {
		if (this.closed) return;
		this.socket.write(`${JSON.stringify(message)}\n`);
	}

	private receive(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line) this.dispatch(line);
			newline = this.buffer.indexOf("\n");
		}
	}

	private dispatch(line: string): void {
		let message: Message;
		try {
			message = JSON.parse(line);
		} catch {
			this.send({
				jsonrpc: "2.0",
				id: 0,
				error: { code: RpcErrorCode.ParseError, message: "invalid JSON" },
			});
			return;
		}
		if ("method" in message) {
			if ("id" in message)
				void this.answer(message.id, message.method, message.params);
			else this.notificationHandler?.(message.method, message.params);
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		if (pending.timer) clearTimeout(pending.timer);
		if ("error" in message)
			pending.reject(new RpcError(message.error.code, message.error.message));
		else pending.resolve(message.result);
	}

	private async answer(
		id: number,
		method: string,
		params: unknown,
	): Promise<void> {
		if (!this.requestHandler) {
			this.send({
				jsonrpc: "2.0",
				id,
				error: { code: RpcErrorCode.MethodNotFound, message: method },
			});
			return;
		}
		try {
			const result = await this.requestHandler(method, params);
			this.send({ jsonrpc: "2.0", id, result: result ?? null });
		} catch (error) {
			const code =
				error instanceof RpcError ? error.code : RpcErrorCode.Internal;
			const message = error instanceof Error ? error.message : String(error);
			this.send({ jsonrpc: "2.0", id, error: { code, message } });
		}
	}

	private shutdown(): void {
		if (this.closed) return;
		this.closed = true;
		for (const [, pending] of this.pending) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(new RpcError(RpcErrorCode.Closed, "connection closed"));
		}
		this.pending.clear();
		for (const handler of this.closeHandlers) handler();
	}
}

export function connectRpc(path: string, timeoutMs = 1000): Promise<RpcPeer> {
	return new Promise((resolve, reject) => {
		const socket = netConnect(path);
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new RpcError(RpcErrorCode.Timeout, "connect timed out"));
		}, timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			resolve(new RpcPeer(socket));
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

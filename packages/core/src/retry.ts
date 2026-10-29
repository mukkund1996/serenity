import { RpcError, RpcErrorCode } from "./rpc";

/**
 * Retrying calls to serenity's dependencies (ADR 0043): exponential backoff
 * with full jitter, and only for errors that may pass on their own.
 */

export interface Backoff {
	/** The delay before the first retry is drawn from [0, baseMs]. */
	baseMs: number;
	/** No delay is drawn from a range above this. */
	maxMs: number;
}

export interface RetryPolicy extends Backoff {
	/** Tries in all, the first included. */
	attempts: number;
}

/** gh, git and tmux calls from the daemon: about 2 s at worst before giving up. */
export const DEPENDENCY_RETRY: RetryPolicy = {
	attempts: 3,
	baseMs: 200,
	maxMs: 2000,
};

/** The map reconnecting to the daemon: forever, never more than 5 s apart. */
export const RECONNECT_BACKOFF: Backoff = { baseMs: 250, maxMs: 5000 };

/** The wait before retry number `retry` (0 for the first): random in [0, min(max, base·2^retry)]. */
export function backoffMs(
	retry: number,
	backoff: Backoff,
	random: () => number = Math.random,
): number {
	const ceiling = Math.min(backoff.maxMs, backoff.baseMs * 2 ** retry);
	return Math.round(random() * ceiling);
}

export interface RetryOptions {
	policy?: RetryPolicy;
	/** Whether an error may pass on its own; anything else is thrown at once. */
	isTransient: (error: unknown) => boolean;
	onRetry?: (error: unknown, retry: number, delayMs: number) => void;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `fn`, retrying transient errors; throws the last error once tries run out. */
export async function withRetry<T>(
	fn: () => Promise<T>,
	opts: RetryOptions,
): Promise<T> {
	const policy = opts.policy ?? DEPENDENCY_RETRY;
	for (let retry = 0; ; retry++) {
		try {
			return await fn();
		} catch (error) {
			if (retry + 1 >= policy.attempts || !opts.isTransient(error)) throw error;
			const delay = backoffMs(retry, policy, opts.random);
			opts.onRetry?.(error, retry, delay);
			await (opts.sleep ?? sleep)(delay);
		}
	}
}

/**
 * Error text that says the dependency, or the way to it, was briefly
 * unavailable: timeouts, dropped connections, 5xx answers, a held git lock,
 * a tmux server that went away mid-call. Auth, "not found" and missing
 * binaries are not transient: retrying would only fail again.
 */
const TRANSIENT =
	/timed? ?out|ECONNRESET|ECONNREFUSED|ECONNABORTED|EAGAIN|EPIPE|ETIMEDOUT|connection (?:reset|refused|closed|aborted)|temporarily unavailable|HTTP 5\d\d|bad gateway|service unavailable|gateway time|TLS handshake|could not resolve host|network is unreachable|unexpected EOF|lost server|server exited unexpectedly|\.lock'?:? File exists|unable to create '[^']*\.lock'|cannot lock ref/i;

export function isTransientMessage(text: string): boolean {
	return TRANSIENT.test(text);
}

/** A request that timed out or lost its connection may succeed on a new one. */
export function isTransientRpcError(error: unknown): boolean {
	return (
		error instanceof RpcError &&
		(error.code === RpcErrorCode.Timeout || error.code === RpcErrorCode.Closed)
	);
}

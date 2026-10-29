import {
	type Backoff,
	backoffMs,
	type DependencyIssue,
	RECONNECT_BACKOFF,
} from "@serenity/core";

/**
 * The map's link to the daemon (ADR 0043). It reconnects forever with
 * backoff; "reconnecting" turns to "down" once the daemon has been away
 * DOWN_AFTER_MS. Calls made meanwhile wait a little for the link, never
 * queued to run later.
 */
export type LinkStatus = "connecting" | "connected" | "reconnecting" | "down";

/** How long without the daemon before the header turns red. */
export const DOWN_AFTER_MS = 15_000;
/** How long a keypress waits for a reconnect before it fails. */
export const CALL_WAIT_MS = 3_000;
/** How long without the daemon before starting one (ADR 0005). */
export const START_AFTER_MS = 3_000;

export interface LinkPeer {
	readonly isClosed: boolean;
	onClose(handler: () => void): void;
	close(): void;
}

export interface LinkOptions<P extends LinkPeer> {
	/** A connected peer, or null when the daemon cannot be reached. */
	connect(): Promise<P | null>;
	/** Subscribes on a fresh peer; a throw drops it and reconnects. */
	ready(peer: P): Promise<void>;
	/** Starts a daemon process; called once per outage. */
	startDaemon(): void;
	onStatus(status: LinkStatus): void;
	backoff?: Backoff;
	downAfterMs?: number;
	startAfterMs?: number;
	random?: () => number;
}

export class DaemonLink<P extends LinkPeer> {
	private peer: P | null = null;
	private status: LinkStatus = "connecting";
	private stopped = false;
	/** Failed tries since the link was last up. */
	private retries = 0;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private downTimer: ReturnType<typeof setTimeout> | undefined;
	private startTimer: ReturnType<typeof setTimeout> | undefined;
	private waiters: Array<(peer: P) => void> = [];

	constructor(private readonly opts: LinkOptions<P>) {}

	start(): void {
		this.outage();
		void this.connect();
	}

	stop(): void {
		this.stopped = true;
		this.clearTimers();
		this.peer?.close();
		this.peer = null;
	}

	get current(): P | null {
		return this.peer;
	}

	/** The peer once the link is up, or null after `timeoutMs`. */
	waitForPeer(timeoutMs = CALL_WAIT_MS): Promise<P | null> {
		if (this.peer) return Promise.resolve(this.peer);
		return new Promise((resolve) => {
			const waiter = (peer: P) => {
				clearTimeout(timer);
				resolve(peer);
			};
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w !== waiter);
				resolve(null);
			}, timeoutMs);
			this.waiters.push(waiter);
		});
	}

	private setStatus(status: LinkStatus): void {
		if (status === this.status) return;
		this.status = status;
		this.opts.onStatus(status);
	}

	/** The daemon went away, or was never there: arm the "down" and start timers. */
	private outage(): void {
		this.downTimer = setTimeout(
			() => this.setStatus("down"),
			this.opts.downAfterMs ?? DOWN_AFTER_MS,
		);
		this.startTimer = setTimeout(
			() => this.opts.startDaemon(),
			this.opts.startAfterMs ?? START_AFTER_MS,
		);
	}

	private clearTimers(): void {
		clearTimeout(this.retryTimer);
		clearTimeout(this.downTimer);
		clearTimeout(this.startTimer);
	}

	private retry(): void {
		if (this.stopped) return;
		const delay = backoffMs(
			this.retries++,
			this.opts.backoff ?? RECONNECT_BACKOFF,
			this.opts.random,
		);
		this.retryTimer = setTimeout(() => void this.connect(), delay);
	}

	private async connect(): Promise<void> {
		const peer = await this.opts.connect().catch(() => null);
		if (this.stopped) return peer?.close();
		if (!peer) return this.retry();
		let up = false;
		peer.onClose(() => {
			if (this.peer === peer) this.peer = null;
			if (this.stopped || !up) return;
			this.setStatus("reconnecting");
			this.outage();
			this.retry();
		});
		try {
			await this.opts.ready(peer);
		} catch {
			peer.close();
			return this.retry();
		}
		if (this.stopped) return peer.close();
		if (peer.isClosed) return this.retry();
		up = true;
		this.peer = peer;
		this.retries = 0;
		this.clearTimers();
		this.setStatus("connected");
		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) waiter(peer);
	}
}

export interface Badge {
	text: string;
	color: "yellow" | "red";
}

/** The header's word on the link; none while it is up. */
export function linkBadge(status: LinkStatus): Badge | null {
	if (status === "connecting")
		return { text: " connecting… ", color: "yellow" };
	if (status === "reconnecting")
		return { text: " reconnecting… ", color: "yellow" };
	if (status === "down")
		return { text: " daemon down · see daemon.log ", color: "red" };
	return null;
}

const ISSUE_MAX = 32;

/** One red badge per dependency that keeps failing, e.g. " gh not logged in ". */
export function healthBadges(issues: DependencyIssue[]): Badge[] {
	return issues.map(({ message }) => ({
		text: ` ${message.length > ISSUE_MAX ? `${message.slice(0, ISSUE_MAX - 1)}…` : message} `,
		color: "red",
	}));
}

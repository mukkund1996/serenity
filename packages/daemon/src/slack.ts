import {
	parseSlackInbox,
	SLACK_INBOX_SCHEMA,
	SLACK_READ_TOOLS,
	type SlackDismissalStore,
	type SlackInbox,
	type SlackItem,
	slackInboxPrompt,
	slackMessageKey,
} from "@serenity/core";
import type { ClaudeRunner } from "./claude";

export interface SlackHost {
	runner: ClaudeRunner;
	model: string;
	/** Where the worker runs; not a repo, so nothing there is loaded. */
	cwd: string;
	/** `--mcp-config` JSON holding only the Slack server. */
	mcpConfig: string;
	/** Messages the user dismissed (ADR 0034); they never show again. */
	dismissals: SlackDismissalStore;
	/** Whether any map of a repo with Slack on is open; polling stops when none is. */
	watching(): boolean;
	/** Sends the new state to every open map of a repo with Slack on. */
	broadcast(): void;
	/** After every successful read, changed or not. */
	onInbox(items: SlackItem[]): void;
	log(line: string): void;
	now(): number;
	pollMs: number;
}

/** Opening a map reads Slack at most this often. */
const OPEN_REFRESH_MS = 60_000;
/** Reading Slack takes several tool calls. */
const INBOX_TIMEOUT_MS = 180_000;

/**
 * The threads and mentions waiting on the user (ADR 0023). Slack is per
 * account, so one read serves every repo with Slack on. Nothing fires when
 * someone writes to the user, so like review requests it is polled: on
 * opening a map, then every `pollMs` while such a map is open.
 */
export class SlackWatcher {
	private current: SlackInbox = { items: [], error: null, checkedAt: null };
	private timer: ReturnType<typeof setInterval> | null = null;
	private inflight = false;
	/** slackMessageKey of every dismissed message. */
	private readonly dismissed: Set<string>;

	constructor(private readonly host: SlackHost) {
		this.dismissed = new Set(host.dismissals.list().map(slackMessageKey));
	}

	state(): SlackInbox {
		return this.current;
	}

	/** A map of a repo with Slack on opened. */
	watch(): void {
		if (!this.timer)
			this.timer = setInterval(() => {
				if (this.host.watching()) return void this.refresh();
				if (this.timer) clearInterval(this.timer);
				this.timer = null;
			}, this.host.pollMs);
		const at = this.current.checkedAt ?? 0;
		if (this.host.now() - at >= OPEN_REFRESH_MS) void this.refresh();
	}

	async refresh(): Promise<void> {
		if (this.inflight) return;
		this.inflight = true;
		let next: SlackInbox;
		try {
			const raw = await this.host.runner.runJson({
				prompt: slackInboxPrompt(this.host.now(), this.host.dismissals.list()),
				model: this.host.model,
				schema: SLACK_INBOX_SCHEMA,
				cwd: this.host.cwd,
				mcpConfig: this.host.mcpConfig,
				allowedTools: SLACK_READ_TOOLS,
				timeoutMs: INBOX_TIMEOUT_MS,
			});
			const inbox = parseSlackInbox(raw);
			if (!inbox) throw new Error("unusable answer");
			// The worker is told to skip dismissed messages; this makes sure.
			next = {
				...inbox,
				items: this.undismissed(inbox.items),
				checkedAt: this.host.now(),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.host.log(`slack inbox failed: ${message}`);
			// A failed read keeps the last items rather than blanking the section.
			next = {
				items: this.undismissed(this.current.items),
				error: `Slack: ${message.slice(0, 80)}`,
				checkedAt: this.host.now(),
			};
		} finally {
			this.inflight = false;
		}
		const changed =
			JSON.stringify({ ...next, checkedAt: 0 }) !==
			JSON.stringify({ ...this.current, checkedAt: 0 });
		this.current = next;
		if (changed) this.host.broadcast();
		if (!next.error) this.host.onInbox(next.items);
	}

	/**
	 * x on a Slack item (ADR 0034): it leaves NEEDS YOU now and for good,
	 * across restarts. Only this message: a newer one in its thread shows.
	 */
	dismiss(channelId: string, ts: string): void {
		const key = slackMessageKey({ channelId, ts });
		if (!this.dismissed.has(key)) {
			this.host.dismissals.add({ channelId, ts, at: this.host.now() });
			this.dismissed.add(key);
		}
		const items = this.undismissed(this.current.items);
		if (items.length === this.current.items.length) return;
		this.current = { ...this.current, items };
		this.host.broadcast();
		this.host.onInbox(items);
	}

	private undismissed(items: SlackItem[]): SlackItem[] {
		return items.filter((i) => !this.dismissed.has(slackMessageKey(i)));
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}

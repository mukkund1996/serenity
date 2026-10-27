import {
	parseSlackInbox,
	SLACK_INBOX_SCHEMA,
	SLACK_READ_TOOLS,
	type SlackInbox,
	type SlackItem,
	slackInboxPrompt,
} from "@serenity/core";
import type { ClaudeRunner } from "./claude";

export interface SlackHost {
	runner: ClaudeRunner;
	model: string;
	/** Where the worker runs; not a repo, so nothing there is loaded. */
	cwd: string;
	/** `--mcp-config` JSON holding only the Slack server. */
	mcpConfig: string;
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

	constructor(private readonly host: SlackHost) {}

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
				prompt: slackInboxPrompt(this.host.now()),
				model: this.host.model,
				schema: SLACK_INBOX_SCHEMA,
				cwd: this.host.cwd,
				mcpConfig: this.host.mcpConfig,
				allowedTools: SLACK_READ_TOOLS,
				timeoutMs: INBOX_TIMEOUT_MS,
			});
			const inbox = parseSlackInbox(raw);
			if (!inbox) throw new Error("unusable answer");
			next = { ...inbox, checkedAt: this.host.now() };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.host.log(`slack inbox failed: ${message}`);
			// A failed read keeps the last items rather than blanking the section.
			next = {
				items: this.current.items,
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

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}

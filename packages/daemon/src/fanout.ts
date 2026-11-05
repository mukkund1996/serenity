import { randomUUID } from "node:crypto";
import {
	type CreateSessionParams,
	childReport,
	type FanoutSession,
	fanoutLabel,
	fanoutProblem,
	fanoutText,
	type MasterToolResult,
	PROMPT_LOOKBACK,
	parseFanoutSessions,
	reportMessage,
	type Session,
	type Storage,
	type Suggestion,
	userAskedForSessions,
} from "@serenity/core";

/** What the fan-out needs from the daemon. */
export interface FanoutHost {
	storage: Storage;
	now(): number;
	log(line: string): void;
	broadcast(repo: string): void;
	create(params: CreateSessionParams): Promise<Session>;
	/** Types one line into a session's claude and submits it. */
	send(session: Session, text: string): Promise<void>;
}

/** Marks text serenity typed into a session, so it is never read as the user's. */
const OWN_PREFIX = "[serenity]";

/**
 * Fan-out (ADR 0060): an agent's request_sessions, the NEEDS YOU proposal
 * it may become, and the reports a child's turns send back to its parent.
 */
export class Fanout {
	/** parent id → reports not yet delivered (it was busy). In memory only. */
	private readonly pending = new Map<string, string[]>();
	private readonly delivering = new Set<string>();

	constructor(private readonly host: FanoutHost) {}

	/** An agent's tool call, from `serenity mcp-agent`. */
	async tool(
		sessionId: string,
		name: string,
		args: Record<string, unknown>,
	): Promise<MasterToolResult> {
		if (name !== "request_sessions")
			return { text: `Unknown tool ${name}.`, isError: true };
		const parent = this.host.storage.sessions.get(sessionId);
		if (!parent)
			return {
				text: "This Claude Code session is not one serenity runs, so it cannot start sessions.",
				isError: true,
			};
		return this.request(parent, args);
	}

	private async request(
		parent: Session,
		args: Record<string, unknown>,
	): Promise<MasterToolResult> {
		const sessions = parseFanoutSessions(args.sessions);
		if (typeof sessions === "string") return { text: sessions, isError: true };
		const all = this.host.storage.sessions.listByRepo(parent.repo);
		const problem = fanoutProblem(parent, sessions.length, all);
		if (problem) return { text: problem, isError: true };
		const taken = sessions.find((s) =>
			all.some(
				(o) =>
					o.status !== "archived" &&
					o.name.toLowerCase() === s.name.toLowerCase(),
			),
		);
		if (taken)
			return {
				text: `A session named ${taken.name} is already on the map; pick another name.`,
				isError: true,
			};
		const reason =
			typeof args.reason === "string" && args.reason.trim()
				? args.reason.trim()
				: "split the work";
		// The agent's word is not enough: the user's own latest prompt must ask.
		const asked =
			args.user_asked === true &&
			userAskedForSessions(this.latestUserPrompt(parent.id));
		if (asked) {
			const { started, failed } = await this.start(parent, sessions);
			this.host.log(
				`${parent.name} fanned out ${started.join(", ") || "nothing"} at the user's request`,
			);
			return {
				text: [
					started.length ? `Started ${started.join(", ")}.` : "",
					failed.length ? `Could not start: ${failed.join("; ")}.` : "",
					started.length
						? "They show on the map under you. serenity tells you here when each finishes a turn; carry on, don't wait or poll."
						: "",
				]
					.filter(Boolean)
					.join(" "),
				isError: started.length === 0,
			};
		}
		this.propose(parent, sessions, reason);
		const why =
			args.user_asked === true
				? "The user's latest message did not ask for new sessions, so "
				: "";
		return {
			text: `${why}${fanoutLabel(sessions)} waits in the user's NEEDS YOU; they start only if the user presses y. serenity tells you here either way. Carry on with your own work meanwhile; don't wait or poll.`,
		};
	}

	/** The user's last prompt to a session, or null if serenity typed it. */
	private latestUserPrompt(sessionId: string): string | null {
		const event = this.host.storage.events
			.listForSession(sessionId, PROMPT_LOOKBACK)
			.find((e) => e.kind === "UserPromptSubmit");
		const prompt =
			typeof event?.payload.prompt === "string" ? event.payload.prompt : null;
		return prompt?.trimStart().startsWith(OWN_PREFIX) ? null : prompt;
	}

	/** The fanout proposal on the parent, replacing an earlier one. */
	private propose(
		parent: Session,
		sessions: FanoutSession[],
		reason: string,
	): Suggestion {
		for (const g of this.host.storage.suggestions.listPending(parent.repo))
			if (g.sessionId === parent.id && g.kind === "fanout")
				this.host.storage.suggestions.put({
					...g,
					status: "superseded",
					updatedAt: this.host.now(),
				});
		const at = this.host.now();
		const suggestion: Suggestion = {
			id: randomUUID(),
			repo: parent.repo,
			sessionId: parent.id,
			kind: "fanout",
			label: fanoutLabel(sessions),
			text: fanoutText(sessions, reason),
			sessions,
			status: "pending",
			source: "agent",
			createdAt: at,
			updatedAt: at,
		};
		this.host.storage.suggestions.put(suggestion);
		this.host.log(`${parent.name} proposed ${suggestion.label}`);
		this.host.broadcast(parent.repo);
		return suggestion;
	}

	/** y on a fanout: starts its sessions; throws if none could start. */
	async accept(suggestion: Suggestion): Promise<void> {
		const parent = this.host.storage.sessions.get(suggestion.sessionId);
		if (!parent) throw new Error("the session that asked is gone");
		const sessions = suggestion.sessions ?? [];
		const problem = fanoutProblem(
			{ ...parent, status: parent.status === "dead" ? "idle" : parent.status },
			sessions.length,
			this.host.storage.sessions.listByRepo(parent.repo),
		);
		if (problem) throw new Error(problem);
		const { started, failed } = await this.start(parent, sessions);
		this.report(
			parent,
			started.length
				? `the user started ${started.join(", ")}${failed.length ? `; could not start ${failed.join("; ")}` : ""}`
				: `none of the sessions could start: ${failed.join("; ")}`,
		);
		if (!started.length) throw new Error(failed.join("; "));
	}

	/** n on a fanout: the parent hears that the user said no. */
	declined(suggestion: Suggestion): void {
		const parent = this.host.storage.sessions.get(suggestion.sessionId);
		if (!parent) return;
		const names = (suggestion.sessions ?? []).map((s) => s.name).join(", ");
		this.report(
			parent,
			`the user declined starting ${names}; do that work here, or ask them`,
		);
	}

	private async start(
		parent: Session,
		sessions: FanoutSession[],
	): Promise<{ started: string[]; failed: string[] }> {
		const started: string[] = [];
		const failed: string[] = [];
		for (const s of sessions) {
			try {
				const child = await this.host.create({
					repo: parent.repo,
					name: s.name,
					cwd: parent.repo,
					mode: "worktree",
					prompt: s.prompt,
					parentId: parent.id,
					topic: parent.topic,
				});
				started.push(child.name);
			} catch (error) {
				failed.push(
					`${s.name} (${error instanceof Error ? error.message : String(error)})`,
				);
			}
		}
		return { started, failed };
	}

	/** After every change to a session, with what it was before. */
	onSessionChanged(before: Session, after: Session): void {
		if (after.parentId) {
			const report = childReport(before, after);
			const parent = this.host.storage.sessions.get(after.parentId);
			if (report && parent) this.report(parent, report);
		}
		// A parent that is free again hears what came in while it was busy.
		if (this.pending.has(after.id) && ready(after))
			queueMicrotask(() => void this.deliver(after.id));
	}

	/** Queues a report for a parent and delivers it once the parent is free. */
	private report(parent: Session, text: string): void {
		if (parent.status === "archived" || parent.status === "dead") return;
		const list = this.pending.get(parent.id) ?? [];
		list.push(text);
		this.pending.set(parent.id, list);
		queueMicrotask(() => void this.deliver(parent.id));
	}

	private async deliver(parentId: string): Promise<void> {
		if (this.delivering.has(parentId)) return;
		const parent = this.host.storage.sessions.get(parentId);
		const reports = this.pending.get(parentId);
		if (!parent || !reports?.length) return;
		if (parent.status === "archived" || parent.status === "dead") {
			this.pending.delete(parentId);
			return;
		}
		if (!ready(parent)) return;
		this.pending.delete(parentId);
		this.delivering.add(parentId);
		try {
			await this.host.send(parent, reportMessage(reports));
			this.host.log(`told ${parent.name} about ${reports.length} report(s)`);
		} catch (error) {
			this.host.log(
				`could not tell ${parent.name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.delivering.delete(parentId);
		}
	}
}

/**
 * A parent takes a report only between turns: not while it works, and not
 * while it waits on the user, where typed text would answer for them.
 */
function ready(s: Session): boolean {
	return (
		(s.status === "idle" || s.status === "done") &&
		s.tracking === "hooks" &&
		!!s.tmuxPane
	);
}

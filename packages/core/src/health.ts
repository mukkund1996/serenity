/**
 * Whether serenity's dependencies answer (ADR 0043). One failed call, even
 * after its retries, can be a blip; a dependency is reported down once
 * FAILURES_TO_REPORT calls in a row have failed, and up again on its next
 * success.
 */

export type Dependency = "gh" | "git" | "tmux" | "slack";

/** A dependency that keeps failing, shown in the map's header. */
export interface DependencyIssue {
	dependency: Dependency;
	/** Short, e.g. "gh not logged in", "tmux unreachable". */
	message: string;
	/** When the first of the failures in a row happened. */
	since: number;
}

export const FAILURES_TO_REPORT = 2;

interface Entry {
	failures: number;
	message: string;
	since: number;
}

export class DependencyHealth {
	private readonly entries = new Map<Dependency, Entry>();

	constructor(
		/** Called when the list of issues changes. */
		private readonly onChange: () => void = () => {},
		private readonly now: () => number = Date.now,
	) {}

	/** A call to `dependency` answered: null, or failed for good: why. */
	report(dependency: Dependency, problem: string | null): void {
		const before = JSON.stringify(this.issues());
		if (problem === null) this.entries.delete(dependency);
		else {
			const entry = this.entries.get(dependency);
			this.entries.set(dependency, {
				failures: (entry?.failures ?? 0) + 1,
				message: problem,
				since: entry?.since ?? this.now(),
			});
		}
		if (JSON.stringify(this.issues()) !== before) this.onChange();
	}

	issues(): DependencyIssue[] {
		return [...this.entries]
			.filter(([, entry]) => entry.failures >= FAILURES_TO_REPORT)
			.map(([dependency, { message, since }]) => ({
				dependency,
				message,
				since,
			}))
			.sort((a, b) => a.dependency.localeCompare(b.dependency));
	}
}

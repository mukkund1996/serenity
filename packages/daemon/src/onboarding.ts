import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	CreateSessionParams,
	Onboarded,
	Session,
	Storage,
} from "@serenity/core";
import TUTORIAL_SKILL from "../../../plugins/learn-serenity/skills/learn-serenity/SKILL.md" with {
	type: "text",
};

/** The first-boot tutorial's session (ADR 0062). */
export const TUTORIAL_NAME = "learn-serenity";
/** Its first prompt; the learn-serenity skill answers it. */
export const TUTORIAL_PROMPT = "teach me how to use serenity";

export interface OnboardingDeps {
	storage: Storage;
	/** Config `onboarding` and SERENITY_NO_ONBOARDING, read when a map opens. */
	enabled(): boolean;
	/** The branch the repo's main checkout is on; the tutorial runs there, with no worktree. */
	currentBranch(repo: string): Promise<string>;
	/** Creates the session; `onId` gets its id before claude launches. */
	create(
		params: CreateSessionParams,
		onId: (sessionId: string) => void,
	): Promise<Session>;
	now(): number;
	log(line: string): void;
}

/**
 * The first-boot tutorial (ADR 0062): the first map opened on a machine
 * with no sessions gets one `learn-serenity` session, prompted with
 * "teach me how to use serenity". It runs once per serenity home, whatever
 * happens to it afterwards; a home that already has sessions (an upgrade)
 * is marked done without one.
 */
export class Onboarding {
	constructor(private readonly deps: OnboardingDeps) {}

	/** The record, once the tutorial ran or was skipped. */
	get record(): Onboarded | null {
		return this.deps.storage.recovery.get("onboarding");
	}

	/** Whether `sessionId` is the tutorial, which gets the learn-serenity plugin. */
	isTutorial(sessionId: string): boolean {
		return !!sessionId && this.record?.sessionId === sessionId;
	}

	/**
	 * A map opened on `repo`. The record is written before the first await,
	 * so a second map opening meanwhile finds it and starts nothing.
	 */
	async mapOpened(repo: string): Promise<void> {
		if (this.record) return;
		const { storage, now, log } = this.deps;
		const skip = (skipped: string) => {
			storage.recovery.set("onboarding", {
				at: now(),
				repo: null,
				sessionId: null,
				skipped,
			});
			log(`onboarding: skipped (${skipped})`);
		};
		if (!this.deps.enabled()) return skip("off");
		if (storage.sessions.listAll().length > 0) return skip("existing sessions");
		// Recorded before the session starts, so nothing can start a second one.
		storage.recovery.set("onboarding", {
			at: now(),
			repo,
			sessionId: null,
		});
		try {
			const branch = await this.deps.currentBranch(repo);
			await this.deps.create(
				{
					repo,
					name: TUTORIAL_NAME,
					cwd: repo,
					mode: "branch",
					branch,
					prompt: TUTORIAL_PROMPT,
				},
				// Stored before claude launches, so its first launch gets the plugin.
				(sessionId) =>
					storage.recovery.set("onboarding", {
						at: now(),
						repo,
						sessionId,
					}),
			);
			log(`onboarding: started ${TUTORIAL_NAME} in ${repo}`);
		} catch (e) {
			const message = (e as Error).message;
			storage.recovery.set("onboarding", {
				at: now(),
				repo,
				sessionId: null,
				skipped: message,
			});
			log(`onboarding: ${TUTORIAL_NAME} did not start: ${message}`);
		}
	}
}

/** Writes the learn-serenity plugin the tutorial session loads with `--plugin-dir`. */
export function writeTutorialPlugin(dir: string): void {
	mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
	mkdirSync(join(dir, "skills", TUTORIAL_NAME), { recursive: true });
	writeFileSync(
		join(dir, ".claude-plugin", "plugin.json"),
		`${JSON.stringify({ name: TUTORIAL_NAME, description: "A hands-on tour of serenity.", version: "1" }, null, 2)}\n`,
	);
	writeFileSync(join(dir, "skills", TUTORIAL_NAME, "SKILL.md"), TUTORIAL_SKILL);
}

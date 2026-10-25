import { run } from "./exec";

/**
 * Thin tmux driver (ADR 0004). `socketName` selects a private tmux server
 * (`tmux -L`), which the E2E tests use; in normal use it is unset.
 */
export class Tmux {
	constructor(
		private readonly socketName: string | undefined = process.env
			.SERENITY_TMUX_SOCKET,
	) {}

	private cmd(args: string[]): Promise<string> {
		return run(
			this.socketName
				? ["tmux", "-L", this.socketName, ...args]
				: ["tmux", ...args],
		);
	}

	async hasSession(name: string): Promise<boolean> {
		try {
			await this.cmd(["has-session", "-t", `=${name}`]);
			return true;
		} catch {
			return false;
		}
	}

	async ensureSession(name: string, cwd: string): Promise<void> {
		if (await this.hasSession(name)) return;
		await this.cmd(["new-session", "-d", "-s", name, "-c", cwd]);
		await this.cmd(["set-option", "-t", `=${name}:`, "status", "off"]);
	}

	/** Starts `command` in a new background window of `session`; returns its pane id. */
	newWindow(opts: {
		session: string;
		name: string;
		cwd: string;
		env: Record<string, string>;
		command: string[];
	}) {
		const env = Object.entries(opts.env).flatMap(([key, value]) => [
			"-e",
			`${key}=${value}`,
		]);
		return this.cmd([
			"new-window",
			"-d",
			"-t",
			`=${opts.session}:`,
			"-n",
			opts.name,
			"-c",
			opts.cwd,
			...env,
			"-P",
			"-F",
			"#{pane_id}",
			...opts.command,
		]);
	}

	async paneExists(pane: string): Promise<boolean> {
		try {
			return (
				(await this.cmd([
					"display-message",
					"-p",
					"-t",
					pane,
					"#{pane_id}",
				])) === pane
			);
		} catch {
			return false;
		}
	}

	setPaneOption(pane: string, option: string, value: string): Promise<string> {
		return this.cmd(["set-option", "-p", "-t", pane, option, value]);
	}

	setWindowOption(
		target: string,
		option: string,
		value: string,
	): Promise<string> {
		return this.cmd(["set-option", "-w", "-t", target, option, value]);
	}

	unsetWindowOption(target: string, option: string): Promise<string> {
		return this.cmd(["set-option", "-w", "-u", "-t", target, option]);
	}

	/** Types text into a pane literally, then presses Enter. */
	async sendText(pane: string, text: string): Promise<void> {
		await this.cmd(["send-keys", "-t", pane, "-l", text]);
		await this.cmd(["send-keys", "-t", pane, "Enter"]);
	}

	/** Moves `source` into the window of `target`, to its right, taking `percent` of the width. */
	async joinRight(
		source: string,
		target: string,
		percent: number,
	): Promise<void> {
		await this.cmd([
			"join-pane",
			"-h",
			"-l",
			`${percent}%`,
			"-s",
			source,
			"-t",
			target,
		]);
		await this.cmd(["select-pane", "-t", source]);
	}

	/** Moves a pane back out into its own background window of `session`. */
	async park(pane: string, session: string, name: string): Promise<void> {
		await this.cmd([
			"break-pane",
			"-d",
			"-s",
			pane,
			"-t",
			`=${session}:`,
			"-n",
			name,
		]);
	}

	/** Presses one key (no Enter), e.g. "1" to pick the first option of a menu. */
	async pressKey(pane: string, key: string): Promise<void> {
		await this.cmd(["send-keys", "-t", pane, key]);
	}

	async killPane(pane: string): Promise<void> {
		await this.cmd(["kill-pane", "-t", pane]);
	}

	selectPane(pane: string): Promise<string> {
		return this.cmd(["select-pane", "-t", pane]);
	}

	/**
	 * Ctrl+g in an agent pane detaches it back to the map; anywhere else it
	 * passes through. Agent panes are marked with the @serenity_session option.
	 */
	bindDetachKey(detachCommand: string): Promise<string> {
		return this.cmd([
			"bind-key",
			"-n",
			"C-g",
			"if-shell",
			"-F",
			"#{@serenity_session}",
			`run-shell -b "${detachCommand} #{pane_id}"`,
			"send-keys C-g",
		]);
	}
}

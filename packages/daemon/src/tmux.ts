import { run } from "./exec";

/** Ctrl+m as a CSI u key, after its Escape: `ESC [ 109 ; 5 u`. */
const CTRL_M_CSI_U = "[109;5u";
/** Shift+Enter as a CSI u key, after its Escape; Ink reads it as Enter with shift. */
const SHIFT_ENTER_CSI_U = "[13;2u";

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

	/** Where a pane is, e.g. { session: "guide", window: "0", windowName: "modals" }. */
	async describePane(
		pane: string,
	): Promise<{ session: string; window: string; windowName: string }> {
		// tmux prints a tab as "_"; session names cannot contain ":".
		const out = await this.cmd([
			"display-message",
			"-p",
			"-t",
			pane,
			"#{session_name}:#{window_index}:#{window_name}",
		]);
		const [session = "", window = "", ...name] = out.split(":");
		return { session, window, windowName: name.join(":") };
	}

	/** The visible text of a pane. */
	capturePane(pane: string): Promise<string> {
		return this.cmd(["capture-pane", "-p", "-t", pane]);
	}

	/** The tty of a tmux client currently showing `pane`, if any. */
	async clientShowing(pane: string): Promise<string | null> {
		const out = await this.cmd([
			"list-clients",
			"-F",
			"#{client_tty} #{pane_id}",
		]).catch(() => "");
		for (const line of out.split("\n")) {
			const [tty, current] = line.split(" ");
			if (tty && current === pane) return tty;
		}
		return null;
	}

	/** Shows `pane` (its session, window and pane) on client `tty`. */
	async switchClient(tty: string, pane: string): Promise<void> {
		await this.cmd(["switch-client", "-c", tty, "-t", pane]);
	}

	unsetPaneOption(pane: string, option: string): Promise<string> {
		return this.cmd(["set-option", "-p", "-u", "-t", pane, option]);
	}

	/** Replaces whatever runs in `pane` with `command`, keeping the pane in place. */
	respawnPane(opts: {
		pane: string;
		cwd: string;
		env: Record<string, string>;
		command: string[];
	}): Promise<string> {
		const env = Object.entries(opts.env).flatMap(([key, value]) => [
			"-e",
			`${key}=${value}`,
		]);
		return this.cmd([
			"respawn-pane",
			"-k",
			"-t",
			opts.pane,
			"-c",
			opts.cwd,
			...env,
			...opts.command,
		]);
	}

	/** Presses one key (no Enter), e.g. "1" to pick the first option of a menu. */
	async pressKey(pane: string, key: string): Promise<void> {
		await this.cmd(["send-keys", "-t", pane, key]);
	}

	/** Renames the window holding `pane`. */
	renameWindow(pane: string, name: string): Promise<string> {
		return this.cmd(["rename-window", "-t", pane, name]);
	}

	async killPane(pane: string): Promise<void> {
		await this.cmd(["kill-pane", "-t", pane]);
	}

	selectPane(pane: string): Promise<string> {
		return this.cmd(["select-pane", "-t", pane]);
	}

	/**
	 * Ctrl+g in an agent pane detaches it back to the map; Ctrl+m does too and
	 * then focuses the master. In the map pane Ctrl+m reaches the map as a CSI u
	 * key, which it tells apart from Enter. Anywhere else both pass through.
	 * Shift+Enter reaches the map pane as a CSI u key too, a new line in the
	 * master input (ADR 0038); other panes get it unchanged.
	 * Agent panes carry the @serenity_session option, the map pane @serenity_map.
	 * Ctrl+m and Shift+Enter differ from Enter only when the terminal sends
	 * extended keys.
	 */
	async bindSessionKeys(detachCommand: string): Promise<void> {
		await this.cmd([
			"bind-key",
			"-n",
			"C-g",
			"if-shell",
			"-F",
			"#{@serenity_session}",
			`run-shell -b "${detachCommand} #{pane_id}"`,
			"send-keys C-g",
		]);
		await this.cmd([
			"bind-key",
			"-n",
			"C-m",
			"if-shell",
			"-F",
			"#{@serenity_session}",
			`run-shell -b "${detachCommand} #{pane_id} master"`,
			`if-shell -F "#{@serenity_map}" "send-keys Escape '${CTRL_M_CSI_U}'" "send-keys C-m"`,
		]);
		await this.cmd([
			"bind-key",
			"-n",
			"S-Enter",
			"if-shell",
			"-F",
			"#{@serenity_map}",
			`send-keys Escape '${SHIFT_ENTER_CSI_U}'`,
			"send-keys S-Enter",
		]);
	}

	/** Presses Ctrl+m in `pane` as a CSI u key, as the binding does in the map pane. */
	async pressCtrlM(pane: string): Promise<void> {
		await this.cmd(["send-keys", "-t", pane, "Escape", CTRL_M_CSI_U]);
	}

	/**
	 * The tmux settings Claude Code recommends: extended keys so Shift+Enter
	 * reaches it as a newline instead of submitting, and passthrough for its
	 * notifications. Extended keys only go to programs that ask for them, so
	 * other panes are unaffected. Adds `extkeys` once, not on every attach.
	 */
	async enableClaudeKeys(): Promise<void> {
		await this.cmd(["set-option", "-s", "extended-keys", "on"]);
		const features = await this.cmd([
			"show-options",
			"-s",
			"-v",
			"terminal-features",
		]);
		if (!features.includes("xterm*:extkeys"))
			await this.cmd([
				"set-option",
				"-as",
				"terminal-features",
				"xterm*:extkeys",
			]);
		await this.cmd(["set-option", "-g", "allow-passthrough", "on"]);
	}
}

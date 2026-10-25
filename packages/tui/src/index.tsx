import { spawnSync } from "node:child_process";
import { connectDaemon, tmuxSessionName } from "@serenity/core";
import { render } from "ink";
import { App } from "./App";

export { drawTopics, moveFocus } from "./topics";

export async function runTui(opts: {
	home: string;
	repo: string;
}): Promise<void> {
	const tmuxPane = process.env.TMUX_PANE;
	const instance = render(
		<App home={opts.home} repo={opts.repo} tmuxPane={tmuxPane} />,
		{
			// Ink draws only the last frame when CI is set; the map is useless that way.
			interactive: true,
			alternateScreen: true,
			incrementalRendering: true,
			exitOnCtrlC: true,
		},
	);
	// Attaching or detaching resizes this pane and switches the view at the
	// same moment. We own the whole (alternate) screen, so on every resize wipe
	// it and make Ink draw the next frame in full. Prepended so it runs before
	// Ink's own handler.
	const repaint = () => {
		process.stdout.write(HOME_AND_ERASE_SCREEN);
		instance.clear();
	};
	process.stdout.prependListener("resize", repaint);
	await instance.waitUntilExit();
	process.stdout.off("resize", repaint);
	if (tmuxPane) {
		await parkAttached(opts.home, tmuxPane);
		leaveSerenitySession(opts.repo, tmuxPane);
	}
}

const HOME_AND_ERASE_SCREEN = "\x1b[H\x1b[2J";

/**
 * If a session is still joined beside this map pane, park it before the map
 * goes; otherwise its Claude pane is left filling the map's window.
 */
async function parkAttached(home: string, clientPane: string): Promise<void> {
	const peer = await connectDaemon(home);
	await peer
		?.request("session.detach", { clientPane }, { timeoutMs: 2000 })
		.catch(() => {});
	peer?.close();
}

/**
 * When the map runs in serenity's own tmux session, quitting it detaches the
 * terminal from that session; otherwise tmux would just show the next window,
 * which is a parked Claude session. The agents keep running in the background.
 * Inside the user's own tmux session nothing is detached.
 */
function leaveSerenitySession(repo: string, pane: string): void {
	const socket = process.env.SERENITY_TMUX_SOCKET;
	const tmux = (args: string[]) =>
		spawnSync("tmux", socket ? ["-L", socket, ...args] : args, {
			encoding: "utf8",
		});
	const session = tmux([
		"display-message",
		"-p",
		"-t",
		pane,
		"#{session_name}",
	]).stdout.trim();
	if (session === tmuxSessionName(repo))
		tmux(["detach-client", "-s", `=${session}:`]);
}

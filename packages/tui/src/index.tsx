import { connectDaemon } from "@serenity/core";
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
			alternateScreen: true,
			incrementalRendering: true,
			exitOnCtrlC: true,
		},
	);
	await instance.waitUntilExit();
	if (tmuxPane) await parkAttached(opts.home, tmuxPane);
}

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

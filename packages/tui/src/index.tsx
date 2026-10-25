import { render } from "ink";
import { App } from "./App";

export { drawTopics, moveFocus } from "./topics";

export async function runTui(opts: {
	home: string;
	repo: string;
}): Promise<void> {
	const instance = render(
		<App home={opts.home} repo={opts.repo} tmuxPane={process.env.TMUX_PANE} />,
		{
			alternateScreen: true,
			incrementalRendering: true,
			exitOnCtrlC: true,
		},
	);
	await instance.waitUntilExit();
}

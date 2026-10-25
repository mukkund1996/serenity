import { spawn } from "node:child_process";

/** Opens a URL in the user's browser (`o` on a card), without waiting for it. */
export function openUrl(url: string): void {
	const command = process.platform === "darwin" ? "open" : "xdg-open";
	spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
}

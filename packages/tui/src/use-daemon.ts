import {
	connectDaemon,
	type Method,
	type Params,
	type RepoState,
	type Result,
	type RpcPeer,
	startDaemonProcess,
} from "@serenity/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { DaemonLink, type LinkStatus } from "./daemon-link";

export interface DaemonConnection {
	state: RepoState | null;
	/** "reconnecting" keeps the last state on screen; "down" after a while (ADR 0043). */
	link: LinkStatus;
	call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>>;
}

/** Subscribes to one repo's state and keeps reconnecting if the daemon goes away. */
export function useDaemon(
	home: string,
	repo: string,
	clientPane?: string,
): DaemonConnection {
	const [state, setState] = useState<RepoState | null>(null);
	const [link, setLink] = useState<LinkStatus>("connecting");
	const linkRef = useRef<DaemonLink<RpcPeer> | null>(null);

	useEffect(() => {
		const daemon = new DaemonLink<RpcPeer>({
			connect: () => connectDaemon(home),
			ready: async (peer) => {
				peer.onNotification((method, params) => {
					if (method === "state.changed" && (params as RepoState).repo === repo)
						setState(params as RepoState);
				});
				setState(await peer.request("state.subscribe", { repo, clientPane }));
			},
			startDaemon: () => startDaemonProcess(home),
			onStatus: setLink,
		});
		linkRef.current = daemon;
		daemon.start();
		return () => daemon.stop();
	}, [home, repo, clientPane]);

	const call = useCallback(
		async <M extends Method>(
			method: M,
			params: Params<M>,
		): Promise<Result<M>> => {
			const peer = await linkRef.current?.waitForPeer();
			if (!peer) throw new Error("not sent: daemon unreachable");
			return peer.request(method, params, { timeoutMs: 30_000 });
		},
		[],
	);

	return { state, link, call };
}

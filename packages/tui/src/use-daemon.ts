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

const RETRY_MS = 1000;
/** After this many failed reconnects, start a fresh daemon. */
const RESTART_AFTER = 3;

export interface DaemonConnection {
	state: RepoState | null;
	connected: boolean;
	call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>>;
}

/** Subscribes to one repo's state and keeps reconnecting if the daemon goes away. */
export function useDaemon(home: string, repo: string): DaemonConnection {
	const [state, setState] = useState<RepoState | null>(null);
	const [connected, setConnected] = useState(false);
	const peerRef = useRef<RpcPeer | null>(null);

	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let failures = 0;

		const retry = () => {
			if (cancelled) return;
			failures++;
			if (failures === RESTART_AFTER) startDaemonProcess(home);
			timer = setTimeout(connect, RETRY_MS);
		};

		const connect = async () => {
			const peer = await connectDaemon(home);
			if (cancelled) {
				peer?.close();
				return;
			}
			if (!peer) return retry();
			peerRef.current = peer;
			peer.onNotification((method, params) => {
				if (method === "state.changed" && (params as RepoState).repo === repo)
					setState(params as RepoState);
			});
			peer.onClose(() => {
				peerRef.current = null;
				setConnected(false);
				failures = 0;
				retry();
			});
			try {
				setState(await peer.request("state.subscribe", { repo }));
				setConnected(true);
				failures = 0;
			} catch {
				peer.close();
			}
		};

		void connect();
		return () => {
			cancelled = true;
			clearTimeout(timer);
			peerRef.current?.close();
		};
	}, [home, repo]);

	const call = useCallback(
		<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> => {
			const peer = peerRef.current;
			if (!peer) return Promise.reject(new Error("daemon not connected"));
			return peer.request(method, params, { timeoutMs: 30_000 });
		},
		[],
	);

	return { state, connected, call };
}

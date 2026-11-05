import {
	describeSetupStatus,
	type Method,
	type Params,
	type Result,
	SETUP_STEPS,
	type SetupStatus,
	type SetupStepId,
	setupDone,
} from "@serenity/core";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { Key, TitledBox } from "./components";
import { openUrl } from "./open-url";
import { runInPopup } from "./popup";

const PANEL_W = 72;
/** How often, and how many times, to look for Slack's name after it connects. */
const NAME_LOOK_MS = 3000;
const NAME_LOOKS = 5;

type Call = <M extends Method>(
	method: M,
	params: Params<M>,
) => Promise<Result<M>>;

/** How a step runs: its command in a popup over the map (ADR 0065). */
export type RunStep = (id: SetupStepId, repo: string) => Promise<void>;

export const runStepInPopup: RunStep = (id, repo) =>
	runInPopup(["setup", id, "--popup"], repo);

/**
 * The setup steps' statuses (ADR 0065), and `run`, which runs a step's login
 * in a popup and checks again. Shared by the Setup and settings panels.
 */
export function useSetup(call: Call, repo: string, runStep: RunStep) {
	const [steps, setSteps] = useState<SetupStatus[] | null>(null);
	const [running, setRunning] = useState<SetupStepId | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(
		() =>
			call("setup.status", { repo }).then(
				(r) => {
					setSteps(r);
					return r;
				},
				(e: Error) => {
					setError(e.message);
					return null;
				},
			),
		[call, repo],
	);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Slack's name comes with its first read after it is turned on: look again a few times.
	const nameless = !!steps?.some(
		(s) => s.id === "slack" && s.connected && s.on && !s.user,
	);
	const looks = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: each new check schedules the next look
	useEffect(() => {
		if (!nameless || looks.current >= NAME_LOOKS) return;
		const timer = setTimeout(() => {
			looks.current++;
			void refresh();
		}, NAME_LOOK_MS);
		return () => clearTimeout(timer);
	}, [nameless, steps, refresh]);

	const run = async (id: SetupStepId): Promise<SetupStatus | null> => {
		setRunning(id);
		setError(null);
		try {
			await runStep(id, repo);
		} catch (e) {
			setError((e as Error).message);
		}
		const next = await refresh();
		setRunning(null);
		return next?.find((s) => s.id === id) ?? null;
	};

	return { steps, running, error, run, refresh };
}

export type SetupState = ReturnType<typeof useSetup>;

/** A step's one-line status, with its mark: ✓ done, ○ to do, … checking. */
export function StepStatus({
	status,
	running,
}: {
	status: SetupStatus | undefined;
	running: boolean;
}) {
	if (running || !status)
		return <Text color="gray">{running ? "logging in…" : "checking…"}</Text>;
	const done = setupDone(status);
	return (
		<Text color={done ? "green" : "yellow"} wrap="truncate">
			{done ? "✓ " : "○ "}
			{describeSetupStatus(status)}
		</Text>
	);
}

/**
 * The Setup panel (ADR 0065): on first boot, and from the settings panel.
 * One row per step in SETUP_STEPS: what it enables, its status, Enter to
 * connect, s to skip. Every step is optional; Esc closes.
 */
export function SetupPanel({
	setup,
	onClose,
}: {
	setup: SetupState;
	onClose: () => void;
}) {
	const [at, setAt] = useState(0);
	const [note, setNote] = useState<string | null>(null);
	const step = SETUP_STEPS[at] ?? SETUP_STEPS[0];
	const statusOf = (id: SetupStepId) => setup.steps?.find((s) => s.id === id);

	// Once checked, start at the first step left to do: gh is often logged in already.
	const checked = !!setup.steps;
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the first check lands
	useEffect(() => {
		const todo = SETUP_STEPS.findIndex((s) => {
			const status = setup.steps?.find((x) => x.id === s.id);
			return status && !setupDone(status);
		});
		if (todo > 0) setAt(todo);
	}, [checked]);

	const last = at + 1 >= SETUP_STEPS.length;
	const next = () => {
		if (last) return onClose();
		setAt(at + 1);
		setNote(null);
	};

	useInput((input, key) => {
		if (setup.running) return;
		if (key.escape) return onClose();
		if (key.upArrow) return setAt(Math.max(0, at - 1));
		if (key.downArrow || key.tab) return setAt((at + 1) % SETUP_STEPS.length);
		if (input === "s") return next();
		if (input === "o" && step?.link) return openUrl(step.link, setNote);
		if (key.return && step) {
			const now = statusOf(step.id);
			if (now && setupDone(now)) return next();
			setNote(null);
			void setup.run(step.id).then((after) => {
				if (!after) return;
				if (!setupDone(after))
					return setNote(`${step.title}: ${describeSetupStatus(after)}`);
				// The last step stays in view, so its ✓ shows before Enter closes.
				if (!last) next();
			});
		}
	});

	const allDone =
		!!setup.steps?.length &&
		SETUP_STEPS.every((s) => {
			const status = statusOf(s.id);
			return status && setupDone(status);
		});
	return (
		<TitledBox
			title="Set up serenity"
			titleColor="whiteBright"
			fill="black"
			borderStyle="double"
			borderColor="white"
			width={PANEL_W}
			right={<Text color="white"> Esc done </Text>}
		>
			<Text color="white" wrap="wrap">
				Two optional logins. Skip either; Ctrl+, has them later.
			</Text>
			{SETUP_STEPS.map((s, i) => {
				const selected = i === at;
				return (
					<Box key={s.id} flexDirection="column" marginTop={1}>
						<Box>
							<Box width={12} flexShrink={0}>
								<Text
									color={selected ? "whiteBright" : "white"}
									bold={selected}
								>
									{selected ? "› " : "  "}
									{s.title}
								</Text>
							</Box>
							<StepStatus
								status={statusOf(s.id)}
								running={setup.running === s.id}
							/>
						</Box>
						{s.enables.map((line) => (
							<Text
								key={line}
								color={selected ? "white" : "gray"}
								wrap="truncate"
							>
								{"    · "}
								{line}
							</Text>
						))}
						{selected &&
						statusOf(s.id) &&
						!setupDone(statusOf(s.id) as SetupStatus) ? (
							<Text color="gray" wrap="wrap">
								{"    "}
								{s.without}
							</Text>
						) : null}
					</Box>
				);
			})}
			<Box marginTop={1}>
				<Text color={setup.error ? "red" : "yellow"} wrap="wrap">
					{setup.error ?? note ?? " "}
				</Text>
			</Box>
			<Text color="white">
				<Key>↑↓</Key> move <Key>Enter</Key> {allDone ? "done" : "connect"}{" "}
				<Key>s</Key> skip
				{step?.link ? (
					<>
						{" "}
						<Key>o</Key> privacy
					</>
				) : null}{" "}
				<Key>Esc</Key> done
			</Text>
		</TitledBox>
	);
}

/** The Setup panel with its own checks, as an overlay over the map. */
export function SetupOverlay({
	call,
	repo,
	onClose,
	runStep = runStepInPopup,
}: {
	call: Call;
	repo: string;
	onClose: () => void;
	runStep?: RunStep;
}) {
	const setup = useSetup(call, repo, runStep);
	return <SetupPanel setup={setup} onClose={onClose} />;
}

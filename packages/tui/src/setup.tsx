import {
	ago,
	describeSetupStatus,
	HISTORY_DAYS,
	type HistorySession,
	historyLabel,
	IMPORT_PREVIEW,
	IMPORT_STEP,
	importSummary,
	type Method,
	nextOpenStep,
	type Params,
	type Result,
	SETUP_STEPS,
	type SetupStatus,
	type SetupStepId,
	setupDone,
	setupIntro,
	setupStep,
} from "@serenity/core";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { Key, TitledBox } from "./components";
import { openUrl } from "./open-url";
import { ImportDialog } from "./overlays";
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
 * The import step (ADR 0066): this repo's past Claude Code sessions, found
 * with the same dry run as `I` (`history.discover`) and imported with the
 * same `history.import`. Ended cards: nothing runs until Enter resumes one.
 */
export function useImportStep(call: Call, repo: string) {
	const [found, setFound] = useState<HistorySession[] | null>(null);
	const [state, setState] = useState<"todo" | "done" | "skipped">("todo");
	const [imported, setImported] = useState(0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		call("history.discover", {
			repo,
			since: Date.now() - HISTORY_DAYS * 86_400_000,
		}).then(
			(r) => setFound(r.sessions),
			() => setFound([]),
		);
	}, [call, repo]);

	const importIds = async (ids: string[]): Promise<boolean> => {
		if (!ids.length) return false;
		setBusy(true);
		setError(null);
		try {
			const sessions = await call("history.import", {
				repo,
				claudeSessionIds: ids,
			});
			setImported(sessions.length);
			setState("done");
			return true;
		} catch (e) {
			setError((e as Error).message);
			return false;
		} finally {
			setBusy(false);
		}
	};

	return {
		found,
		state,
		imported,
		busy,
		error,
		importIds,
		importAll: () => importIds((found ?? []).map((s) => s.claudeSessionId)),
		skip: () => setState("skipped"),
	};
}

export type ImportStepState = ReturnType<typeof useImportStep>;

type Row =
	| { kind: "login"; id: SetupStepId; title: string }
	| { kind: "import"; title: string };

/**
 * The first-boot panel (ADR 0065, 0066): this repo's past sessions when
 * there are any, then GitHub and Slack, then "You're set". One line per step
 * says what it gives; Enter does it, s skips it, Esc closes.
 */
export function SetupPanel({
	setup,
	importStep,
	firstBoot = true,
	onClose,
}: {
	setup: SetupState;
	importStep?: ImportStepState;
	firstBoot?: boolean;
	onClose: () => void;
}) {
	const [at, setAt] = useState(0);
	const [note, setNote] = useState<string | null>(null);
	const [skipped, setSkipped] = useState<Set<SetupStepId>>(new Set());
	const [picking, setPicking] = useState(false);
	const statusOf = (id: SetupStepId) => setup.steps?.find((s) => s.id === id);
	const past = importStep?.found ?? [];

	// Import first, then the logins. While it is still looking, the import
	// row shows "checking…"; with no past sessions it isn't shown at all.
	const looking = !!importStep && importStep.found === null;
	const rows: Row[] = [
		...(looking || past.length
			? [{ kind: "import" as const, title: IMPORT_STEP.title }]
			: []),
		...SETUP_STEPS.map((s) => ({
			kind: "login" as const,
			id: s.id,
			title: s.title,
		})),
	];
	const open = (row: Row): boolean => {
		if (row.kind === "import") return importStep?.state === "todo";
		const status = statusOf(row.id);
		return !skipped.has(row.id) && !(status && setupDone(status));
	};
	const row = rows[at];
	const finished = at >= rows.length;
	const busy = !!setup.running || !!importStep?.busy;

	// Once checked, start at the first step left to do (gh is often logged
	// in already), unless a key was pressed meanwhile.
	const moved = useRef(false);
	const checked =
		(!!setup.steps || !!setup.error) && (!importStep || !!importStep.found);
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the first checks land
	useEffect(() => {
		if (!checked || moved.current) return;
		setAt(nextOpenStep(rows.map(open), -1));
	}, [checked]);

	const advance = (from = at, skip?: SetupStepId) => {
		const nowOpen = rows.map(
			(r, i) => i !== from && (r.kind !== "login" || r.id !== skip) && open(r),
		);
		setAt(nextOpenStep(nowOpen, from));
		setNote(null);
	};

	useInput(
		(input, key) => {
			if (busy) return;
			if (key.escape) return onClose();
			// Rows can still change (the import row) until both checks land.
			if (!checked) return;
			moved.current = true;
			if (key.upArrow) return setAt(Math.max(0, Math.min(at, rows.length) - 1));
			if (key.downArrow || key.tab) return setAt(Math.min(rows.length, at + 1));
			if (finished || !row) {
				if (key.return) onClose();
				return;
			}
			if (row.kind === "import") {
				if (importStep?.state !== "todo") {
					if (key.return) advance();
					return;
				}
				if (input === "s") {
					importStep.skip();
					return advance();
				}
				if (input === "p") return setPicking(true);
				if (key.return)
					void importStep.importAll().then((ok) => ok && advance());
				return;
			}
			const step = SETUP_STEPS.find((s) => s.id === row.id);
			if (!step) return;
			if (input === "s") {
				setSkipped((set) => new Set(set).add(step.id));
				return advance(at, step.id);
			}
			if (input === "o" && step.link) return openUrl(step.link, setNote);
			if (!key.return) return;
			const now = statusOf(step.id);
			if (now && setupDone(now)) return advance();
			setNote(null);
			void setup.run(step.id).then((after) => {
				if (!after) return;
				if (!setupDone(after))
					return setNote(`${step.title}: ${describeSetupStatus(after)}`);
				advance();
			});
		},
		{ isActive: !picking },
	);

	if (picking && importStep)
		return (
			<ImportDialog
				candidates={[]}
				history={past}
				gone={0}
				days={HISTORY_DAYS}
				onAllRepos={() => Promise.resolve(past)}
				onSubmit={async (_live, ids) => {
					const ok = await importStep.importIds(ids);
					setPicking(false);
					if (ok) advance();
				}}
				onClose={() => setPicking(false)}
			/>
		);

	const error = setup.error ?? importStep?.error ?? null;
	const now = Date.now();
	// The selected step's keys; the privacy link sits on Slack's note line.
	const keys: Array<[string, string]> =
		row && !open(row)
			? [
					["Enter", "next"],
					["↑↓", "move"],
				]
			: row?.kind === "import"
				? [
						["Enter", "import all"],
						["p", "pick"],
						["s", "skip"],
						["↑↓", "move"],
					]
				: [
						["Enter", "log in"],
						["s", "skip"],
						["↑↓", "move"],
					];

	return (
		<TitledBox
			title="Welcome to serenity"
			titleColor="whiteBright"
			fill="black"
			borderStyle="double"
			borderColor="white"
			width={PANEL_W}
			right={<Text color="white"> Esc close </Text>}
		>
			<Text color="white" wrap="wrap">
				{setupIntro(rows.length)}
			</Text>
			{rows.map((r, i) => {
				const selected = i === at;
				const step = r.kind === "login" ? setupStep(r.id) : undefined;
				return (
					<Box
						key={r.kind === "login" ? r.id : "import"}
						flexDirection="column"
						marginTop={1}
					>
						<Box>
							<Box width={12} flexShrink={0}>
								<Text
									color={selected ? "whiteBright" : "white"}
									bold={selected}
								>
									{selected ? "› " : "  "}
									{r.title}
								</Text>
							</Box>
							{r.kind === "login" ? (
								<StepStatus
									status={statusOf(r.id)}
									running={setup.running === r.id}
								/>
							) : (
								<ImportStatus step={importStep} />
							)}
						</Box>
						<Text color={selected ? "white" : "gray"} wrap="truncate">
							{"    "}
							{step ? step.gives : IMPORT_STEP.gives}
						</Text>
						{selected && step?.note ? (
							<Text color="gray" wrap="truncate">
								{"    "}
								{step.note} · <Key>o</Key> PRIVACY.md
							</Text>
						) : null}
						{selected && r.kind === "import" && importStep?.state === "todo"
							? [
									...past.slice(0, IMPORT_PREVIEW).map((s) => (
										<Text key={s.claudeSessionId} color="gray" wrap="truncate">
											{"    · "}
											{historyLabel(s)}
											{s.branch ? ` · ${s.branch}` : ""} ·{" "}
											{ago(s.lastActiveAt, now)}
										</Text>
									)),
									past.length > IMPORT_PREVIEW ? (
										<Text key="more" color="gray">
											{"    "}+{past.length - IMPORT_PREVIEW} more
										</Text>
									) : null,
								]
							: null}
					</Box>
				);
			})}
			<Box marginTop={1}>
				{finished ? (
					<Text color="green">
						✓ You're set.{" "}
						{firstBoot ? "Enter opens the tour." : "Enter closes."}
					</Text>
				) : (
					<Text color={error ? "red" : "yellow"} wrap="wrap">
						{error ?? note ?? " "}
					</Text>
				)}
			</Box>
			{finished ? null : (
				<Text color="white">
					{keys.map(([k, label], n) => (
						<Text key={k}>
							{n ? " · " : ""}
							<Key>{k}</Key> {label}
						</Text>
					))}
				</Text>
			)}
		</TitledBox>
	);
}

/** The import step's status: ○ found, ✓ imported, – skipped. */
function ImportStatus({ step }: { step: ImportStepState | undefined }) {
	if (!step?.found) return <Text color="gray">checking…</Text>;
	if (step.busy) return <Text color="gray">importing…</Text>;
	const line = importSummary(
		step.found.length,
		HISTORY_DAYS,
		step.state,
		step.imported,
	);
	if (step.state === "done") return <Text color="green">✓ {line}</Text>;
	if (step.state === "skipped") return <Text color="gray">– {line}</Text>;
	return <Text color="yellow">○ {line}</Text>;
}

/** The panel with its own checks, as an overlay over the map. */
export function SetupOverlay({
	call,
	repo,
	firstBoot = true,
	onClose,
	runStep = runStepInPopup,
}: {
	call: Call;
	repo: string;
	firstBoot?: boolean;
	onClose: () => void;
	runStep?: RunStep;
}) {
	const setup = useSetup(call, repo, runStep);
	const importStep = useImportStep(call, repo);
	return (
		<SetupPanel
			setup={setup}
			importStep={importStep}
			firstBoot={firstBoot}
			onClose={onClose}
		/>
	);
}

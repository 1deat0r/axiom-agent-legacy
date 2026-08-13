/**
 * Boxed workspace selector: the terminal-side "menu in a box on top of
 * everything" for /profiles and /projects. A bordered, centered list with the
 * current workspace marked — arrow keys move, Enter picks, Escape closes —
 * shown over the chat via showFullPaneOverlay.
 *
 * Selecting a workspace is a BOOT-SCOPED switch in the terminal (profile and
 * project anchor the process at startup, like the /update relaunch): the
 * selection closes the session and relaunches the client under
 * `--profile <name>` / `--project <name>` with a fresh session in that
 * workspace. `buildSwitchRelaunchArgs` derives the child argv.
 */
import { spawnSync } from "node:child_process";
import { Container, type Focusable, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { profileBaseHome } from "../../../cli/profile-command.js";
import { APP_NAME } from "../../../config.js";
import { AXIOM_HOME_ENV } from "../../../extensions/profile/registry.js";
import { getSelectListTheme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

/** One selectable workspace in the boxed menu. */
export interface WorkspaceOption {
	value: string;
	label: string;
	/** The workspace this session currently runs under (marked "(current)"). */
	current?: boolean;
	/** Optional one-line status shown right of the label (e.g. "active", "token set"). */
	description?: string;
}

export interface WorkspaceSelectorOptions {
	title: string;
	options: WorkspaceOption[];
	hint?: string;
	onSelect(value: string): void;
	/** Optional: Esc (or an empty selection) closes the menu without choosing. */
	onCancel?(): void;
}

/** A bordered, centered list menu rendered on top of the chat. */
export class WorkspaceSelectorComponent extends Container implements Focusable {
	private readonly selectList: SelectList;
	private _focused = false;

	constructor(options: WorkspaceSelectorOptions) {
		super();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(` ${options.title} `, 1, 0));
		const items: SelectItem[] = options.options.map((option) => ({
			value: option.value,
			label: option.label,
			description: option.description ?? (option.current ? "(current)" : undefined),
		}));
		this.selectList = new SelectList(items, 10, getSelectListTheme(), {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 32,
		});
		const currentIndex = options.options.findIndex((option) => option.current === true);
		if (currentIndex !== -1) this.selectList.setSelectedIndex(currentIndex);
		this.selectList.onSelect = (item) => options.onSelect(item.value);
		this.selectList.onCancel = () => options.onCancel?.();
		this.addChild(this.selectList);
		if (options.hint) this.addChild(new Text(options.hint, 1, 0));
		this.addChild(new DynamicBorder());
	}
	getSelectList(): SelectList {
		return this.selectList;
	}

	// Focusable: the overlay routes keypresses through the component, which
	// forwards them to the select list (arrow keys, Enter, Escape).
	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

/** Workspace flags the relaunch re-derives (stripped, then re-appended). */
const WORKSPACE_FLAGS = new Set(["--profile", "--project"]);
/** Session-selection flags: a switch starts a FRESH session in the new workspace. */
const SESSION_SELECT_FLAGS = new Set(["--resume", "-r", "--continue", "-c", "--fork"]);
/** Daemon continuity is per agent-home; a switched workspace needs its own daemon. */
const DAEMON_FLAGS = new Set(["--daemon-socket"]);

/**
 * Derive the child argv for a workspace switch: drop the old
 * profile/project/session-selection/daemon flags (both `--flag value` and
 * `--flag=value` forms), preserve everything else in order, then append the
 * new workspace flags.
 */
export function buildSwitchRelaunchArgs(
	args: readonly string[],
	opts: { profile?: string; project?: string },
): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < args.length) {
		const arg = args[i]!;
		const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
		const stripped = WORKSPACE_FLAGS.has(flag) || SESSION_SELECT_FLAGS.has(flag) || DAEMON_FLAGS.has(flag);
		if (stripped) {
			// `--flag=value` carries its value; `--fork` never does; the rest
			// consume the next argv element.
			i += arg.includes("=") || flag === "--fork" ? 1 : 2;
			continue;
		}
		out.push(arg);
		i += 1;
	}
	if (opts.profile) out.push("--profile", opts.profile);
	if (opts.project) out.push("--project", opts.project);
	return out;
}

/** Whether a /profiles or /projects invocation opens the boxed menu (no subcommand). */
export function shouldOpenWorkspaceMenu(args: string): boolean {
	const trimmed = args.trim();
	return trimmed.length === 0 || trimmed.startsWith("-");
}

// =========================================================================
// Workspace relaunch (boot-scoped switch)
// =========================================================================

/** The fields a relaunch needs from a blocking child spawn. */
export interface WorkspaceRelaunchResult {
	status: number | null;
	signal?: string | null;
	error?: Error;
}

/**
 * Process deps for the workspace relaunch. `spawnSync` must BLOCK the parent
 * until the child exits: the child inherits the parent's foreground process
 * group, and if the parent exits first the shell reclaims the terminal and
 * the kernel denies the orphaned child's tcsetattr/read with EIO (the
 * /profiles relaunch crashed with exactly that).
 */
export interface WorkspaceRelaunchDeps {
	spawnSync(
		command: string,
		args: readonly string[],
		options: { stdio: "inherit"; env: NodeJS.ProcessEnv },
	): WorkspaceRelaunchResult;
	exit(code: number): never;
}

export const defaultWorkspaceRelaunchDeps: WorkspaceRelaunchDeps = {
	spawnSync: (command, args, options) => {
		const result = spawnSync(command, [...args], options);
		return { status: result.status, signal: result.signal, error: result.error };
	},
	exit: (code) => process.exit(code),
};

export interface WorkspaceRelaunchOptions {
	/** Child argv derived by buildSwitchRelaunchArgs. */
	relaunchArgs: string[];
	/** Environment for the relaunched client. */
	env: NodeJS.ProcessEnv;
}

/**
 * Relaunch the client under the switched workspace flags. Never returns: the
 * blocking spawn holds the terminal's foreground process group for the child,
 * then the parent exits with the child's status (the /update relaunch
 * pattern). A fire-and-forget spawn would exit the parent immediately,
 * orphan the child's process group, and the relaunched TUI would crash in
 * setRawMode with EIO.
 */
export function relaunchWorkspace(
	argv: readonly string[],
	opts: WorkspaceRelaunchOptions,
	deps: WorkspaceRelaunchDeps = defaultWorkspaceRelaunchDeps,
): never {
	const entrypoint = argv[1];
	if (entrypoint === undefined) {
		console.error(`Failed to relaunch ${APP_NAME}: cannot determine the CLI entrypoint`);
		deps.exit(1);
	}
	const result = deps.spawnSync(process.execPath, [...process.execArgv, entrypoint, ...opts.relaunchArgs], {
		stdio: "inherit",
		env: opts.env,
	});
	if (result.error) {
		console.error(`Failed to relaunch ${APP_NAME}: ${result.error.message}`);
		deps.exit(1);
	}
	deps.exit(result.status ?? (result.signal ? 1 : 0));
}

/**
 * Environment for the relaunched client. A profile switch pins AXIOM_HOME to
 * the profile BASE home so the child resolves `--profile <name>` under the
 * same base the parent used (dropping it would fall back to ~/.axiom and
 * lose a custom AXIOM_HOME). A project switch changes no env.
 */
export function buildWorkspaceRelaunchEnv(
	processEnv: NodeJS.ProcessEnv,
	opts: { profile?: string; project?: string },
	activeHome: string,
): NodeJS.ProcessEnv {
	if (opts.profile === undefined) return processEnv;
	return { ...processEnv, [AXIOM_HOME_ENV]: profileBaseHome(activeHome) };
}

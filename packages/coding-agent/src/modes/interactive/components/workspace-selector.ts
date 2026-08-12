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
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { getSelectListTheme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

/** One selectable workspace in the boxed menu. */
export interface WorkspaceOption {
	value: string;
	label: string;
	/** The workspace this session currently runs under (marked "(current)"). */
	current?: boolean;
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
export class WorkspaceSelectorComponent extends Container {
	private readonly selectList: SelectList;
	constructor(options: WorkspaceSelectorOptions) {
		super();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(` ${options.title} `, 1, 0));
		const items: SelectItem[] = options.options.map((option) => ({
			value: option.value,
			label: option.label,
			description: option.current ? "(current)" : undefined,
		}));
		this.selectList = new SelectList(items, 10, getSelectListTheme(), {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 32,
		});
		const currentIndex = items.findIndex((item) => item.description === "(current)");
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

import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import {
	buildSwitchRelaunchArgs,
	shouldOpenWorkspaceMenu,
	type WorkspaceOption,
	type WorkspaceSelectorOptions,
	WorkspaceSelectorComponent,
} from "../src/modes/interactive/components/workspace-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function makeComponent(options: Partial<WorkspaceSelectorOptions> = {}) {
	const onSelect = vi.fn();
	const onCancel = vi.fn();
	const opts: {
		title: string;
		options: WorkspaceOption[];
		hint?: string;
		onSelect: (value: string) => void;
		onCancel: () => void;
	} = {
		title: "profiles",
		options: [
			{ value: "default", label: "default", current: true },
			{ value: "builder", label: "builder" },
		],
		hint: "↑/↓ choose · Enter switch · Esc close",
		onSelect,
		onCancel,
		...options,
	};
	const component = new WorkspaceSelectorComponent(opts);
	return { component, onSelect, onCancel };
}

describe("WorkspaceSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders the boxed menu with options and the current marker", () => {
		const { component } = makeComponent();
		const rendered = stripAnsi(component.render(60).join("\n"));
		expect(rendered).toContain("profiles");
		expect(rendered).toContain("default");
		expect(rendered).toContain("builder");
		expect(rendered).toContain("(current)");
		expect(rendered).toContain("Enter switch");
	});

	test("fires onSelect with the chosen value on Enter", () => {
		const { component, onSelect } = makeComponent();
		component.getSelectList().setSelectedIndex(1);
		component.getSelectList().handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith("builder");
	});

	test("fires onCancel on Escape", () => {
		const { component, onCancel } = makeComponent();
		component.getSelectList().handleInput("\u001b");
		expect(onCancel).toHaveBeenCalled();
	});

	test("preselects the current option", () => {
		const { component } = makeComponent();
		expect(component.getSelectList().getSelectedItem()?.value).toBe("default");
	});
});

describe("buildSwitchRelaunchArgs", () => {
	test("appends the new profile and drops the old workspace/session flags", () => {
		const out = buildSwitchRelaunchArgs(
			["--profile", "old", "--project", "legacy", "--resume", "sess-1", "--transport", "telegram"],
			{ profile: "builder" },
		);
		expect(out).toEqual(["--transport", "telegram", "--profile", "builder"]);
	});

	test("handles --flag=value forms", () => {
		const out = buildSwitchRelaunchArgs(["--profile=old", "--resume=x"], { project: "acme" });
		expect(out).toEqual(["--project", "acme"]);
	});

	test("strips --daemon-socket so the child attaches its own daemon", () => {
		const out = buildSwitchRelaunchArgs(["--daemon-socket", "/tmp/x.sock"], { profile: "p" });
		expect(out).toEqual(["--profile", "p"]);
	});

	test("preserves unrelated flags and ordering", () => {
		const out = buildSwitchRelaunchArgs(["-v", "--transport", "telegram"], { project: "acme" });
		expect(out).toEqual(["-v", "--transport", "telegram", "--project", "acme"]);
	});

	test("drops --fork (no value) but keeps its sibling value flags paired", () => {
		const out = buildSwitchRelaunchArgs(["--fork", "--continue", "s"], {});
		expect(out).toEqual([]);
	});
});

describe("shouldOpenWorkspaceMenu", () => {
	test("opens the menu only for no-arg (or flag-like) invocations", () => {
		expect(shouldOpenWorkspaceMenu("")).toBe(true);
		expect(shouldOpenWorkspaceMenu("   ")).toBe(true);
		expect(shouldOpenWorkspaceMenu("create builder")).toBe(false);
		expect(shouldOpenWorkspaceMenu("add alpha")).toBe(false);
		expect(shouldOpenWorkspaceMenu("switch p")).toBe(false);
	});
});

import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.js";
import { checkGitCommand } from "../../src/extensions/git-guard/guard.js";
import { createGitGuard } from "../../src/extensions/git-guard/index.js";

/** Minimal fake ExtensionAPI capturing handlers so a test can invoke them (security-fence pattern). */
function fakePi(): { pi: ExtensionAPI; toolCall: (event: Record<string, unknown>) => Promise<unknown> } {
	const handlers = new Map<string, Array<(...a: unknown[]) => unknown>>();
	return {
		pi: fromAny<ExtensionAPI, unknown>({
			on: (evt: string, h: (...a: unknown[]) => unknown) => handlers.set(evt, [...(handlers.get(evt) ?? []), h]),
		}),
		toolCall: async (event) => {
			let result: unknown;
			for (const h of handlers.get("tool_call") ?? []) {
				result = await h(event, undefined);
				if (result && fromPartial<{ block?: boolean }>(result).block) break;
			}
			return result;
		},
	};
}

describe("checkGitCommand - dangerous patterns", () => {
	const blocked = [
		"git push",
		"git push origin main",
		"git push --force",
		"git push -f origin main",
		"git push --force-with-lease origin main",
		"git reset --hard",
		"git reset --hard HEAD~2",
		"git clean -f",
		"git clean -fd",
		"git clean -xdf",
		"git clean --force",
		"git branch -D feature",
		"git branch --no-color -D feature",
		"git checkout .",
		"git checkout -- .",
		"git restore .",
		"git restore -- .",
	];
	for (const command of blocked) {
		it(`blocks: ${command}`, () => {
			const d = checkGitCommand(command);
			expect(d?.blocked).toBe(true);
			expect(d?.pattern).toBeTruthy();
			expect(d?.reason).toMatch(/git guard/i);
		});
	}
});

describe("checkGitCommand - safe commands pass", () => {
	const allowed = [
		"git status",
		"git diff",
		"git diff --stat",
		"git add -A",
		"git commit -m 'feat: x'",
		"git branch -d old",
		"git checkout main",
		"git checkout -b feat/x",
		"git restore src/a.ts",
		"git clean -n",
		"git reset --soft HEAD~1",
		"git log --oneline -5",
		"git worktree list",
		"ls -la",
		"npm test",
	];
	for (const command of allowed) {
		it(`allows: ${command}`, () => {
			expect(checkGitCommand(command)).toBeUndefined();
		});
	}
});

describe("checkGitCommand - git global options do not bypass the guard", () => {
	const bypassAttempts = [
		"git -C /tmp/repo reset --hard",
		"git -C/tmp/repo push",
		"git --git-dir=/tmp/x reset --hard",
		"git --git-dir /tmp/x branch -D feature/y",
		"git -C /a -C /b clean -fd",
		"git -C /repo checkout .",
		"git -C /repo restore .",
		"git -C /repo -C /other reset --hard",
	];
	for (const command of bypassAttempts) {
		it(`blocks: ${command}`, () => {
			const d = checkGitCommand(command);
			expect(d?.blocked).toBe(true);
			expect(d?.pattern).toBeTruthy();
		});
	}
	it("still allows safe commands that use -C", () => {
		expect(checkGitCommand("git -C /tmp/repo status")).toBeUndefined();
		expect(checkGitCommand("git -C /repo log --oneline -3")).toBeUndefined();
	});
	it("does not strip a -C that appears after the subcommand", () => {
		// `git config -C …` is not the global -C; the config line must stay intact.
		expect(checkGitCommand("git config --get remote.origin.url")).toBeUndefined();
	});
	it("keeps allowExact matching on the raw text (operator escape wins)", () => {
		expect(checkGitCommand("git -C /tmp/repo push", { allowExact: ["git -C /tmp/repo push"] })).toBeUndefined();
	});
});

describe("checkGitCommand - matching semantics", () => {
	it("matches anywhere in the text, like the skill's grep (conservative)", () => {
		const d = checkGitCommand(`%%bash
echo "git push"
`);
		expect(d?.blocked).toBe(true);
	});
	it("scans ipython cells for shell fragments and names the pattern", () => {
		const d = checkGitCommand(`%%bash
git reset --hard HEAD~1
`);
		expect(d?.blocked).toBe(true);
		expect(d?.pattern).toBe("reset-hard");
	});
	it("skips empty text", () => {
		expect(checkGitCommand("")).toBeUndefined();
		expect(checkGitCommand("   ")).toBeUndefined();
	});
	it("allows an exact command listed in allowExact (operator escape)", () => {
		expect(checkGitCommand("git push origin main", { allowExact: ["git push origin main"] })).toBeUndefined();
	});
	it("does not allow a near-miss that is not listed exactly", () => {
		const d = checkGitCommand("git push origin master", { allowExact: ["git push origin main"] });
		expect(d?.blocked).toBe(true);
	});
	it("honors extraPatterns from the operator", () => {
		const d = checkGitCommand("git stash drop", {
			extraPatterns: [{ id: "stash-drop", pattern: /\bgit\s+stash\s+drop\b/ }],
		});
		expect(d?.blocked).toBe(true);
		expect(d?.pattern).toBe("stash-drop");
	});
});

describe("createGitGuard wiring", () => {
	it("blocks an anchored bash tool call with a destructive git command", async () => {
		const { pi, toolCall } = fakePi();
		createGitGuard({ root: "/srv/proj" })(pi);
		const res = fromAny<{ block: boolean; reason: string }, unknown>(
			await toolCall({
				type: "tool_call",
				toolName: "bash",
				toolCallId: "1",
				input: { command: "git push origin main" },
			}),
		);
		expect(res.block).toBe(true);
		expect(res.reason).toMatch(/git guard|AXIOM_GIT_GUARD_ALLOW/i);
	});
	it("blocks an anchored ipython tool call whose cell carries a destructive git command", async () => {
		const { pi, toolCall } = fakePi();
		createGitGuard({ root: "/srv/proj" })(pi);
		const res = fromAny<{ block: boolean; reason: string }, unknown>(
			await toolCall({
				type: "tool_call",
				toolName: "ipython",
				toolCallId: "2",
				input: { code: "%%bash\ngit clean -fd\n" },
			}),
		);
		expect(res.block).toBe(true);
	});
	it("allows safe shell commands on an anchored run", async () => {
		const { pi, toolCall } = fakePi();
		createGitGuard({ root: "/srv/proj" })(pi);
		expect(
			await toolCall({ type: "tool_call", toolName: "bash", toolCallId: "3", input: { command: "git status" } }),
		).toBeUndefined();
		expect(
			await toolCall({ type: "tool_call", toolName: "ipython", toolCallId: "4", input: { code: "x = 1 + 1" } }),
		).toBeUndefined();
	});
	it("leaves non-shell tools untouched", async () => {
		const { pi, toolCall } = fakePi();
		createGitGuard({ root: "/srv/proj" })(pi);
		expect(
			await toolCall({
				type: "tool_call",
				toolName: "edit",
				toolCallId: "5",
				input: { path: "a.ts", oldText: "git push", newText: "x" },
			}),
		).toBeUndefined();
	});
	it("honors the exact-command escape hatch", async () => {
		const { pi, toolCall } = fakePi();
		createGitGuard({ root: "/srv/proj", allowExact: ["git push origin main"] })(pi);
		expect(
			await toolCall({
				type: "tool_call",
				toolName: "bash",
				toolCallId: "6",
				input: { command: "git push origin main" },
			}),
		).toBeUndefined();
	});
	it("is inert without a project root", async () => {
		const { pi, toolCall } = fakePi();
		const saved = process.env.AXIOM_PROJECT_ROOT;
		delete process.env.AXIOM_PROJECT_ROOT;
		try {
			createGitGuard()(pi);
			expect(
				await toolCall({ type: "tool_call", toolName: "bash", toolCallId: "7", input: { command: "git push" } }),
			).toBeUndefined();
		} finally {
			if (saved !== undefined) process.env.AXIOM_PROJECT_ROOT = saved;
		}
	});
});

describe("checkGitCommand - further global-option bypasses stay blocked (ADR-0049 follow-up)", () => {
	const bypassAttempts = [
		"git -C '/tmp/with space' reset --hard",
		'git -C "/tmp/with space" push origin main',
		"git -c core.pager=cat reset --hard",
		"git -c user.name=x push",
		"git --work-tree=/tmp/x reset --hard",
		"git --work-tree /tmp/x clean -fd",
		"git --no-pager push",
		"git --bare reset --hard",
		"git -C /a --git-dir=/b -c x=y reset --hard",
		"git --no-pager -C /repo checkout .",
	];
	for (const command of bypassAttempts) {
		it(`blocks: ${command}`, () => {
			const d = checkGitCommand(command);
			expect(d?.blocked).toBe(true);
			expect(d?.pattern).toBeTruthy();
		});
	}
	it("still allows safe commands with global options", () => {
		expect(checkGitCommand("git -c color.ui=always status")).toBeUndefined();
		expect(checkGitCommand("git --no-pager log --oneline -3")).toBeUndefined();
		expect(checkGitCommand('git -C "/tmp/with space" status')).toBeUndefined();
	});
});

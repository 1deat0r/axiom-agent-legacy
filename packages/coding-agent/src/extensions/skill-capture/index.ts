/**
 * Skill-capture extension — step 4 of procedural-memory skills: the fully
 * unattended runtime hook. On `agent_end` it builds a task trace from the
 * session's messages, runs the automatic flagging heuristic, and only when a
 * completed task is flagged reusable does it materialize a skill into a capture
 * directory and surface an offer.
 *
 * Deliberately inert by default: it only acts when enabled (env
 * AXIOM_SKILL_CAPTURE_AUTO=1 or injected `enabled`), so ordinary sessions are
 * unaffected. It never blocks or disrupts a run — it only records + notifies.
 *
 * It also registers the public /learn command (ADR-0080, issue #54): the
 * on-demand front-end over the same pipeline. /learn is always available,
 * even when the unattended hook is disabled — silent-by-default means the
 * loop stays quiet, not that the user cannot ask. Captured skills are staged
 * into the capture directory and offered. Installing is the ownership
 * lattice's job (ADR-0081, issue #55): the hook auto-installs into the loop's
 * own curator-skills directory (curator → curator, silent, audited by the
 * notification), /learn --install does the same on request, and the live
 * curator-skills directory is emitted through the resources_discover seam so
 * installed curator skills actually load — with user/project skills winning
 * name collisions, the precedence the lattice encodes.
 */

import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getAgentDir, getBundledSkillsDir } from "../../config.js";
import type { ExtensionAPI } from "../../core/extensions/types.js";
import type { LatticeConfig } from "../../core/ownership-lattice/index.js";
import {
	CAPTURED_SKILLS_DIR_NAME,
	CURATOR_SKILLS_DIR_NAME,
	defaultLatticeConfig,
	installCapturedSkill,
	type SkillInstallResult,
} from "../../core/ownership-lattice/index.js";
import { getGlobalHarnessStateDir } from "../../core/refinement/index.js";
import type { SessionMessageEntry } from "../../core/session-manager.js";
import type {
	LearnCaptureResult,
	LearnCommandOptions,
	SkillProvenance,
	TaskCapture,
	TaskStep,
	TaskTrace,
} from "../../core/skill-capture/index.js";
import {
	buildSkillDocument,
	CAPTURE_THRESHOLD,
	deriveName,
	evaluateTaskForCapture,
	parseLearnCommandOptions,
	persistCapturedSkill,
	runLearnCapture,
	verifyCapturedSkill,
} from "../../core/skill-capture/index.js";
import { axiomHome } from "../profile/registry.js";

interface ContentBlockLike {
	type?: string;
	text?: string;
	name?: string;
}

/**
 * The message union (`AgentMessage`) is open to custom messages, so rather than
 * narrowing over it we read the fields we need through a minimal structural
 * shape. Only role/content/stopReason are used to build a task trace.
 */
interface MessageLike {
	role: string;
	content: unknown;
	stopReason?: string;
}

const toMessageLike = (message: AgentMessage): MessageLike => message as unknown as MessageLike;

/** First user text used as the task prompt. */
function userPrompt(messages: readonly MessageLike[]): string {
	const user = messages.find((message) => {
		if (message.role !== "user") return false;
		const content = message.content;
		if (typeof content === "string") return content.trim() !== "";
		return (content as ContentBlockLike[]).some((block) => block.type !== "image");
	});
	if (!user) return "";
	const content = user.content;
	if (typeof content === "string") return content;
	return (content as ContentBlockLike[])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join(" ");
}

/** Tool-call summaries become the ordered steps. */
function toolSteps(messages: readonly MessageLike[]): TaskStep[] {
	const steps: TaskStep[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const content = message.content as ContentBlockLike[];
		for (const block of content) {
			if (block.type === "toolCall") {
				steps.push({ summary: block.name ?? "tool" });
			}
		}
	}
	return steps;
}

/** Whether the last assistant turn ended cleanly (stop, not error/aborted/length). */
function completed(messages: readonly MessageLike[]): boolean {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		return message.stopReason === "stop";
	}
	return false;
}

/** Build a unit-testable TaskTrace from the session's message history. */
export function buildTaskTraceFromMessages(messages: readonly AgentMessage[]): TaskTrace {
	const list = messages.map(toMessageLike);
	return { prompt: userPrompt(list), steps: toolSteps(list), completed: completed(list) };
}

/** The default capture builder: provenance source "auto", name from the prompt. */
export function defaultBuildCapture(trace: TaskTrace): TaskCapture {
	const provenance: SkillProvenance = {
		source: "auto",
		createdAt: new Date().toISOString(),
		...(trace.metadata?.sessionId ? { sessionId: String(trace.metadata.sessionId) } : {}),
	};
	return {
		name: deriveName(trace.prompt),
		description: `Captured reusable task: ${trace.prompt.trim().slice(0, 140)}`,
		prompt: trace.prompt,
		steps: [...trace.steps],
		provenance,
		metadata: trace.metadata,
	};
}

/**
 * Turn a /learn result into the in-session report. Captures are info;
 * failures are errors that name what went wrong and how to recover.
 */
export function learnResultMessage(result: LearnCaptureResult): { message: string; severity: "info" | "error" } {
	switch (result.kind) {
		case "captured":
			return {
				message:
					`Captured reusable skill "${result.name}" → ${result.path} (curator staging — the loop's own territory). ` +
					`Verified: loads with ${result.diagnostics.length} loader diagnostics. ` +
					`Install it into the loop's live skills directory with /learn --install, ` +
					`or copy the '${result.name}' directory into your own skills directory.`,
				severity: "info",
			};
		case "not-flagged":
			return {
				message:
					`Not captured (score ${result.score.toFixed(2)} < ${CAPTURE_THRESHOLD}): ` +
					`${result.reasons.join("; ")}. Re-run /learn --force to capture anyway.`,
				severity: "info",
			};
		case "exists":
			return {
				message:
					`Refusing to overwrite existing skill at ${result.path} — ` +
					`learned skills never clobber hand-written ones.`,
				severity: "error",
			};
		case "invalid":
			return { message: `Learn failed: skill validation failed: ${result.errors.join("; ")}`, severity: "error" };
		case "unverified":
			return {
				message: `Learn failed: captured skill failed verification: ${result.errors.join("; ")}`,
				severity: "error",
			};
		case "error":
			return { message: `Learn failed: ${result.errors.join("; ")}`, severity: "error" };
	}
}

/** Turn a lattice install verdict into the in-session report (ADR-0081). */
export function learnInstallResultMessage(result: SkillInstallResult): { message: string; severity: "info" | "error" } {
	switch (result.kind) {
		case "installed":
			return {
				message:
					`Installed "${result.name}" into ${result.to} ` +
					`(curator skills — the loop's live skills directory; loads next session).`,
				severity: "info",
			};
		case "refused":
			return {
				message:
					`Install refused (${result.layer}): ${result.reason}` +
					(result.manual ? ` — run it yourself: ${result.manual}` : ""),
				severity: "error",
			};
		case "missing":
			return { message: `Install failed: ${result.errors.join("; ")}`, severity: "error" };
		case "exists":
			return {
				message: `Install skipped: "${basename(dirname(result.path))}" already installed at ${result.path}.`,
				severity: "error",
			};
		case "error":
			return { message: `Install failed: ${result.errors.join("; ")}`, severity: "error" };
	}
}

/** The live lattice view for an event's cwd, built from the same dirs the
 *  loaders use so the lattice cannot drift from where sessions read. */
function buildLatticeConfig(cwd: string): LatticeConfig {
	return defaultLatticeConfig({
		axiomHome: axiomHome(),
		agentDir: getAgentDir(),
		cwd,
		bundledSkillsDir: getBundledSkillsDir(),
		harnessStateDir: getGlobalHarnessStateDir(),
	});
}

export interface SkillCaptureExtensionOptions {
	/** Enable unattended capture (defaults to env AXIOM_SKILL_CAPTURE_AUTO=1). */
	enabled?: boolean;
	/** Directory to write captured skills into (default <AXIOM_HOME>/captured-skills). */
	captureDir?: string;
	/** Live skills dir installs target (default <AXIOM_HOME>/curator-skills). */
	curatorSkillsDir?: string;
	/** Lattice view for install admission (default: the live profile/agent/cwd dirs). */
	latticeConfig?: LatticeConfig;
	/** Overridable pieces so callers/tests can isolate one concern. */
	buildTrace?: (messages: readonly AgentMessage[]) => TaskTrace;
	buildCapture?: (trace: TaskTrace) => TaskCapture;
}

export function createSkillCaptureExtension(deps: SkillCaptureExtensionOptions = {}): (pi: ExtensionAPI) => void {
	const enabled = deps.enabled ?? process.env.AXIOM_SKILL_CAPTURE_AUTO === "1";
	const captureDir = deps.captureDir ?? join(axiomHome(), CAPTURED_SKILLS_DIR_NAME);
	const curatorSkillsDir = deps.curatorSkillsDir ?? join(axiomHome(), CURATOR_SKILLS_DIR_NAME);
	const buildTrace = deps.buildTrace ?? buildTaskTraceFromMessages;
	const buildCapture = deps.buildCapture ?? defaultBuildCapture;

	return (pi) => {
		pi.registerCommand("learn", {
			description: "Capture this session as a reusable skill on demand (/learn [--force] [--install])",
			handler: async (args, ctx) => {
				let options: LearnCommandOptions;
				try {
					options = parseLearnCommandOptions(args);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(message, "error");
					return;
				}
				const branch = ctx.sessionManager.getBranch();
				const messages = branch
					.filter((entry): entry is SessionMessageEntry => entry.type === "message")
					.map((entry) => entry.message);
				const trace = {
					...buildTrace(messages),
					metadata: { sessionId: ctx.sessionManager.getSessionId() },
				};
				const result = runLearnCapture(trace, { captureDir, force: options.force });
				// --install routes the capture through the lattice (ADR-0081):
				// a staged capture — fresh or already staged — installs into the
				// loop's curator-skills only when the lattice admits it. User-
				// invoked, so the verdict is reported, never silent.
				if (options.install && (result.kind === "captured" || result.kind === "exists")) {
					const name = result.kind === "captured" ? result.name : basename(dirname(result.path));
					const lattice = deps.latticeConfig ?? buildLatticeConfig(ctx.cwd);
					const installed = installCapturedSkill({ fromDir: captureDir, name, toDir: curatorSkillsDir }, lattice);
					const { message, severity } = learnInstallResultMessage(installed);
					ctx.ui.notify(message, severity);
					return;
				}
				const { message, severity } = learnResultMessage(result);
				ctx.ui.notify(message, severity);
			},
		});

		// The live curator skills dir loads through the existing seam when it
		// exists; an absent dir costs nothing (ADR-0081).
		pi.on("resources_discover", () => {
			if (!existsSync(curatorSkillsDir)) return {};
			return { skillPaths: [curatorSkillsDir] };
		});

		pi.on("agent_end", async (event, ctx) => {
			if (!enabled) return;
			const trace = buildTrace(event.messages);
			const evaluation = evaluateTaskForCapture(trace);
			if (!evaluation.shouldCapture) return;
			const built = buildSkillDocument(buildCapture(trace));
			if (!built.ok) return;
			let madeDir = captureDir;
			try {
				mkdirSync(captureDir, { recursive: true });
			} catch {
				madeDir = "";
			}
			if (!madeDir) return;
			const persisted = persistCapturedSkill(captureDir, built.document);
			if (!persisted.ok) return;
			const verified = verifyCapturedSkill(captureDir, built.document.name);
			if (!verified.ok) return;
			// Curator auto-install (ADR-0081): a verified capture installs into
			// the loop's curator-skills, curator → curator, silent and audited by
			// the notification; protected/pinned/outside targets are never
			// touched unattended.
			const lattice = deps.latticeConfig ?? buildLatticeConfig(ctx.cwd);
			const installed = installCapturedSkill(
				{ fromDir: captureDir, name: built.document.name, toDir: curatorSkillsDir },
				lattice,
			);
			const tail = installed.ok
				? `Installed into ${installed.to} (curator skills — loads next session).`
				: `Not installed (${installed.kind}: ${
						"reason" in installed ? installed.reason : installed.errors.join("; ")
					}).`;
			ctx.ui.notify(`Captured reusable skill "${built.document.name}" → ${persisted.path}. ${tail}`, "info");
		});
	};
}

export default function axiomSkillCaptureExtension(pi: ExtensionAPI): void {
	createSkillCaptureExtension()(pi);
}

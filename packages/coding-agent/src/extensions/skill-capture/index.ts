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
 * into the capture directory and offered; installing them into a live skills
 * directory is the ownership lattice's job (issue #55).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "../../core/extensions/types.js";
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
					`Captured reusable skill "${result.name}" → ${result.path}. ` +
					`Verified: loads with ${result.diagnostics.length} loader diagnostics. ` +
					`Install it by copying the '${result.name}' directory into a skills directory.`,
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

export interface SkillCaptureExtensionOptions {
	/** Enable unattended capture (defaults to env AXIOM_SKILL_CAPTURE_AUTO=1). */
	enabled?: boolean;
	/** Directory to write captured skills into (default <AXIOM_HOME>/captured-skills). */
	captureDir?: string;
	/** Overridable pieces so callers/tests can isolate one concern. */
	buildTrace?: (messages: readonly AgentMessage[]) => TaskTrace;
	buildCapture?: (trace: TaskTrace) => TaskCapture;
}

export function createSkillCaptureExtension(deps: SkillCaptureExtensionOptions = {}): (pi: ExtensionAPI) => void {
	const enabled = deps.enabled ?? process.env.AXIOM_SKILL_CAPTURE_AUTO === "1";
	const captureDir = deps.captureDir ?? join(axiomHome(), "captured-skills");
	const buildTrace = deps.buildTrace ?? buildTaskTraceFromMessages;
	const buildCapture = deps.buildCapture ?? defaultBuildCapture;

	return (pi) => {
		pi.registerCommand("learn", {
			description: "Capture this session as a reusable skill on demand (/learn [--force])",
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
				const { message, severity } = learnResultMessage(result);
				ctx.ui.notify(message, severity);
			},
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
			ctx.ui.notify(`Captured reusable skill "${built.document.name}" → ${persisted.path}`, "info");
		});
	};
}

export default function axiomSkillCaptureExtension(pi: ExtensionAPI): void {
	createSkillCaptureExtension()(pi);
}

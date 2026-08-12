/**
 * Skill capture — step 1 of the "skills that learn procedural memory" feature.
 *
 * A captured skill documents a task that was flagged as reusable: it bundles the
 * task's prompt, the ordered steps taken to complete it, and provenance (where
 * the capture came from, when, and which session). Later feature steps add
 * automatic flagging heuristics, an AST-level security audit of third-party
 * skills, and hub/sync (agentskills.io); this module is purely the mechanical
 * capture -> validated skill document -> persisted-skill pipeline.
 */

/** One ordered step taken to complete the captured task. */
export interface TaskStep {
	/** Short imperative summary shown in the skill body. */
	summary: string;
	/** Optional detail/command/output distilled from the session. */
	detail?: string;
}

/** Provenance: where the capture came from and when. Mirrored into frontmatter. */
export interface SkillProvenance {
	/** Human-readable source label, e.g. "session", "manual", "agent". */
	source: string;
	/** ISO timestamp the capture was recorded. */
	createdAt: string;
	/** Optional originating session id. */
	sessionId?: string;
	/** Optional trigger that caused the flag-as-reusable, e.g. an agent instruction. */
	trigger?: string;
}

/** Everything needed to render a skill from a flagged task. */
export interface TaskCapture {
	/** Skill name (must match the parent directory, lowercase a-z0-9-hyphens). */
	name: string;
	/** Skill description — required, non-empty. */
	description: string;
	/** The task prompt / original request the skill generalizes. */
	prompt: string;
	/** Ordered steps taken to complete the task. */
	steps: TaskStep[];
	/** Provenance of the capture. */
	provenance: SkillProvenance;
	/** Optional extra frontmatter `metadata` entries. */
	metadata?: Record<string, unknown>;
	/** Optional extra frontmatter keys surfaced top-level. */
	extraFrontmatter?: Record<string, unknown>;
}

/** A fully rendered, validated skill document ready to persist. */
export interface CapturedSkillDocument {
	/** Validated skill name (equals the parent directory name). */
	name: string;
	/** Validated, non-empty description. */
	description: string;
	/** Frontmatter block (leading and trailing --- included). */
	frontmatter: string;
	/** Full SKILL.md content (frontmatter + body). */
	markdown: string;
	/** Directory name that must hold SKILL.md. */
	directoryName: string;
}

export type CaptureValidationResult = { ok: true; document: CapturedSkillDocument } | { ok: false; errors: string[] };

export type PersistResult =
	| { ok: true; path: string }
	| { ok: false; code: "error"; errors: string[] }
	| { ok: false; code: "exists"; path: string; errors: string[] };

export interface VerifiedSkill {
	name: string;
	description: string;
	filePath: string;
}

export type VerifyResult = { ok: true; skill: VerifiedSkill; diagnostics: string[] } | { ok: false; errors: string[] };

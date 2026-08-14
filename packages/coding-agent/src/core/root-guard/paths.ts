/**
 * Root guard path extraction (ADR-0052) — pure tokenizer.
 *
 * Extracts candidate path tokens from freeform shell / ipython text so the
 * scope gate can classify them against the project root. Conservative by
 * design (matches the git-guard philosophy): the extractor catches the
 * obvious literal path forms — absolute paths, tilde tokens, and relative
 * tokens that carry a slash or a `..`/`.` segment — and stops at shell
 * operators, quotes, and variable expansion ($), so indirection that is
 * purely symbolic (`$HOME`, `os.environ["X"]`) is NOT extracted (a
 * documented gap). A literal path suffix next to a variable (`$X + "/etc"`)
 * IS extracted and may block — the model rewords or requests approval.
 * Shell and python comments are stripped first so prose in comments never
 * blocks. This is best-effort drift protection, not confinement.
 */

/** Token boundary characters: whitespace, quotes, shell operators, braces. */
const BOUNDARY = "[\\s'\"`;|&<>()$=,{}]";

/**
 * Boundary without `$`: relative tokens must not follow a variable
 * reference, so `$HOME/.config/x` (indirection) is invisible to the
 * extractor — a documented gap, not a false positive.
 */
const BOUNDARY_NO_DOLLAR = "[\\s'\"`;|&<>()=,{}]";

/** Characters a path token may contain (everything except the boundaries). */
const TOKEN = `[^\\s'"\`;|&<>()$=,{}]`;

/** Strip shell/python comments (`#` to end of line) from the text. */
export function stripComments(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/#.*$/, ""))
		.join("\n");
}

const ABSOLUTE = `(?:^|${BOUNDARY})/(?!\\/)${TOKEN}+`;
/**
 * A standalone `/` is the root path UNLESS it starts a division operand:
 * the next non-blank char being a name, `$` (the documented indirection
 * gap), `(`, or a digit that is not a `>` redirect (`2>/dev/null`). So
 * Python spaced division (`a / b`, `x = a / (b)`, `x = a / 2`) never
 * blocks, while the destructive bare-root forms (`rm -rf /`,
 * `rm -rf / --no-preserve-root`, `rm -rf /{x}`, `rm -rf /'`, newline and
 * separator continuations) still do. Trade-offs recorded in ADR-0052:
 * `cat / b` misses the bare root (read as an infix operand) and `a / -1`
 * over-blocks (unary minus reads as an argument).
 */
const BARE_ROOT = `(?:^|${BOUNDARY})/(?![ \\t]*(?:[A-Za-z_$]|[0-9](?![0-9]*>)|\\())`;
const TILDE = `(?:^|${BOUNDARY})~[A-Za-z0-9_.+\\-]*(?:/${TOKEN}+)?`;
const RELATIVE = `(?:^|${BOUNDARY_NO_DOLLAR})[A-Za-z0-9_.+@\\-]+/${TOKEN}+`;
const DOTTED_RELATIVE = `(?:^|${BOUNDARY_NO_DOLLAR})\\.\\.?/${TOKEN}+`;
const BARE_DOTDOT = `(?:^|${BOUNDARY_NO_DOLLAR})\\.\\.(?=${BOUNDARY_NO_DOLLAR}|$)`;

const PATTERNS: readonly RegExp[] = [
	new RegExp(ABSOLUTE, "g"),
	new RegExp(BARE_ROOT, "g"),
	new RegExp(TILDE, "g"),
	new RegExp(RELATIVE, "g"),
	new RegExp(DOTTED_RELATIVE, "g"),
	new RegExp(BARE_DOTDOT, "g"),
];

/**
 * `file://` URIs name local files (curl prints them like any path). The
 * scheme prefix swallows the absolute path from the ordinary patterns, so
 * the path part is recovered here as a first-class token (red-team B6).
 */
const FILE_URI = /file:\/\/(\/[^\s'"`;|&<>()=,{}]+)/g;

const LEADING_BOUNDARY = new RegExp(`^${BOUNDARY}`);

/**
 * Candidate path tokens in `text`, deduped in first-appearance order.
 * Each match may include one leading boundary character (the lookbehind
 * substitute); it is sliced off when present.
 */
export function extractCandidatePaths(text: string): string[] {
	const src = stripComments(text);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const m of src.matchAll(FILE_URI)) {
		const token = m[1];
		if (!seen.has(token)) {
			seen.add(token);
			out.push(token);
		}
	}
	for (const pattern of PATTERNS) {
		for (const m of src.matchAll(pattern)) {
			const raw = m[0];
			const token = LEADING_BOUNDARY.test(raw) ? raw.slice(1) : raw;
			if (!seen.has(token)) {
				seen.add(token);
				out.push(token);
			}
		}
	}
	return out;
}

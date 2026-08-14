/**
 * Root guard hardening (ADR-0052 "Hardening (2026-08-14)") — decode plus
 * fail-closed posture for obfuscated shell/python path spellings.
 *
 * Two layers, by design:
 *
 *  1. DECODE (best-effort): shell-escaped slashes (`\/`) and ANSI-C
 *     `$'...'` quoting are decoded before token extraction, so those forms
 *     extract the real path and are judged by the normal scope gate.
 *  2. POSTURE FLIP (the residual): cells that carry obfuscation markers
 *     and name NO known-inside path are blocked outright with a
 *     plain-English reason directing to request_root_access. Perfect
 *     parsing is impossible (documented); the guard fails closed on
 *     ambiguity instead of guessing.
 *
 * All functions are pure (no I/O) so they are trivially unit-testable.
 */

import { stripComments } from "./paths.js";

/** Obfuscation marker kinds. HARD markers flip a cell that names no
 *  known-inside token; SOFT markers flip only near a path-looking string. */
export type MarkerKind =
	| "command-substitution" // $() / backticks
	| "ansi-c-quote" // $'...'
	| "escape-sequence" // \xNN / \NNN / \uNNNN (printf/echo -e spellings)
	| "backslash-path" // \/ or backslash before whitespace
	| "env-prefixed-path" // $VAR/ or ${VAR}/ (the $ gap, now fail-closed)
	| "slash-chr" // chr(47)/chr(0x2f)/... — spells a slash
	| "chr-trick" // chr(...) near a path-looking string
	| "codecs-trick" // codecs.decode near a path-looking string
	| "import-trick" // __import__ near a path-looking string
	| "home-env-ref"; // Path.home()/expanduser/os.environ/getenv (ipython)

/** Decode shell-escaped slashes and ANSI-C $'...' segments. */
export function decodeShellEscapes(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		// `\/` is ALWAYS a shell-escaped slash in bash (backslash preserves
		// the literal value of the next char; `/` has no special meaning).
		if (ch === "\\" && i + 1 < text.length && text[i + 1] === "/") {
			out += "/";
			i += 2;
			continue;
		}
		if (ch === "$" && text[i + 1] === "'") {
			// ANSI-C quoting: decode \xNN / \uNNNN / \NNN / \n / \t / \r / \\ / \'
			let j = i + 2;
			let decoded = "";
			let closed = false;
			while (j < text.length) {
				const c = text[j];
				if (c === "'") {
					closed = true;
					j++;
					break;
				}
				if (c === "\\" && j + 1 < text.length) {
					const e = text[j + 1];
					if (e === "x" || e === "u" || e === "U") {
						const n = e === "x" ? 2 : e === "u" ? 4 : 8;
						const hex = text.slice(j + 2, j + 2 + n);
						if (hex.length === n && /^[0-9a-fA-F]+$/.test(hex)) {
							decoded += String.fromCodePoint(Number.parseInt(hex, 16));
							j += 2 + n;
							continue;
						}
					}
					if (e >= "0" && e <= "7") {
						let oct = e;
						let k = j + 2;
						while (k < text.length && k < j + 4 && text[k] >= "0" && text[k] <= "7") {
							oct += text[k];
							k++;
						}
						decoded += String.fromCodePoint(Number.parseInt(oct, 8));
						j = k;
						continue;
					}
					if (e === "n") {
						decoded += "\n";
						j += 2;
						continue;
					}
					if (e === "t") {
						decoded += "\t";
						j += 2;
						continue;
					}
					if (e === "r") {
						decoded += "\r";
						j += 2;
						continue;
					}
					if (e === "\\" || e === "'" || e === '"') {
						decoded += e;
						j += 2;
						continue;
					}
					// unknown escape: keep both chars (conservative)
					decoded += c + e;
					j += 2;
					continue;
				}
				decoded += c;
				j++;
			}
			if (closed) {
				out += decoded;
				i = j;
				continue;
			}
		}
		out += ch;
		i++;
	}
	return out;
}

const COMMAND_SUB_RE = /\$\(|`/;
const ANSI_C_RE = /\$'/;
const ESCAPE_SEQ_RE = /\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\[0-7]{3}/;
const BACKSLASH_PATH_RE = /\\\/|\\[ \t]/;
const ENV_PREFIXED_RE = /\$[A-Za-z_][A-Za-z0-9_]*\/|\$\{[^}]+\}\//;
const SLASH_CHR_RE = /chr\(\s*(?:47|0x2[fF]|0o57|0b101111)\s*\)/;
const CHR_RE = /chr\(\s*[0-9]/;
const CODECS_RE = /codecs\s*\.\s*decode/;
const IMPORT_RE = /__import__\s*\(/;
const HOME_ENV_RE = /Path\s*\.\s*home\s*\(|\.home\(\)|expanduser\s*\(|os\s*\.\s*environ|getenv\s*\(/;

/**
 * Obfuscation markers in `text` (comments stripped; the ORIGINAL text, so
 * escaped forms the decoder already resolved are still visible here).
 */
export function findObfuscationMarkers(text: string): MarkerKind[] {
	const src = stripComments(text);
	const out: MarkerKind[] = [];
	if (COMMAND_SUB_RE.test(src)) out.push("command-substitution");
	if (ANSI_C_RE.test(src)) out.push("ansi-c-quote");
	if (ESCAPE_SEQ_RE.test(src)) out.push("escape-sequence");
	if (BACKSLASH_PATH_RE.test(src)) out.push("backslash-path");
	if (ENV_PREFIXED_RE.test(src)) out.push("env-prefixed-path");
	if (SLASH_CHR_RE.test(src)) out.push("slash-chr");
	if (CHR_RE.test(src)) out.push("chr-trick");
	if (CODECS_RE.test(src)) out.push("codecs-trick");
	if (IMPORT_RE.test(src)) out.push("import-trick");
	if (HOME_ENV_RE.test(src)) out.push("home-env-ref");
	return out;
}

/** HARD markers: flip a cell that names no known-inside token. */
const HARD: readonly MarkerKind[] = [
	"command-substitution",
	"ansi-c-quote",
	"escape-sequence",
	"backslash-path",
	"env-prefixed-path",
	"slash-chr",
];

/** SOFT markers: flip only near a path-looking string or an extracted token. */
const SOFT: readonly MarkerKind[] = ["chr-trick", "codecs-trick", "import-trick", "home-env-ref"];

export function hasHardMarker(markers: readonly MarkerKind[]): boolean {
	return markers.some((m) => HARD.includes(m));
}

export function hasSoftMarker(markers: readonly MarkerKind[]): boolean {
	return markers.some((m) => SOFT.includes(m));
}

/** True when the text carries a quoted string containing a slash. */
export function hasQuotedSlashString(text: string): boolean {
	return /['"][^'"\n]*\/[^'"\n]*['"]/.test(stripComments(text));
}

// ---- B3: destructive bare-root operands ----

/** Binaries whose bare-root operand is destructive or system-wide. */
const DESTRUCTIVE_BINARIES = ["rm", "chmod", "chown", "cp", "find", "shred", "dd", "mv", "chroot"];

const DESTRUCTIVE_BIN_RE = new RegExp(`(?:^|[\\s;&|])(?:sudo\\s+)?(${DESTRUCTIVE_BINARIES.join("|")})(?=$|[\\s;&|])`);

/**
 * A standalone `/` operand: whitespace-, separator-, `=`, or word-start
 * preceded, and NOT followed by a path token character (a name, digit, or
 * `/`), so `/etc/passwd` (handled by the scope gate) is not double-counted.
 * `/$(...)`, `/{...}`, and quoted forms count as bare-root operands.
 */
const BARE_ROOT_OPERAND_RE = /(?:^|[\s;&|=])\/(?=$|[\s;&|]|[$({'"\\])/;

/**
 * The shell lines of an ipython cell: `%%bash` blocks and `!`-prefixed
 * lines. Returns the joined shell text (empty string when none).
 */
export function shellLinesOfCode(code: string): string {
	const lines: string[] = [];
	let inBashCell = false;
	for (const raw of code.split("\n")) {
		const trimmed = raw.trimStart();
		if (trimmed.startsWith("%%bash")) {
			inBashCell = true;
			continue;
		}
		if (trimmed.startsWith("%%")) {
			inBashCell = false;
			continue;
		}
		if (inBashCell) {
			lines.push(raw);
			continue;
		}
		const bang = raw.match(/^\s*!(.*)$/);
		if (bang) lines.push(bang[1]);
	}
	return lines.join("\n");
}

/**
 * The listed destructive binary name when `command` runs one of them with
 * a bare-root operand (the F2 family: trailing words defeat the tokenizer's
 * bare-root lookahead, so the command must be judged as a whole).
 */
export function checkDestructiveBareRoot(command: string): string | undefined {
	const src = stripComments(command);
	const bin = src.match(DESTRUCTIVE_BIN_RE);
	if (!bin) return undefined;
	if (!BARE_ROOT_OPERAND_RE.test(src)) return undefined;
	return bin[1];
}

// ---- B1 step 1: cd/chdir drift through variable or environment targets ----

const CD_RE = /(?:^|[\s;&|.])(%?cd|chdir)\s*\(?([^\s;&|]+)/g;

/**
 * cd/chdir targets that reference variables, environments, or substitutions:
 * such a change of directory can leave the project root without any literal
 * token the scope gate could judge. Returns the matched targets.
 */
export function findCdDrift(text: string): string[] | undefined {
	const src = stripComments(text);
	const hits: string[] = [];
	for (const m of src.matchAll(CD_RE)) {
		const target = m[2];
		if (/[$({]|environ|getenv|home\(\)|expanduser/.test(target)) hits.push(m[0].trim());
	}
	return hits.length > 0 ? hits : undefined;
}

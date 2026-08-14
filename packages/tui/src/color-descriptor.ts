/**
 * Color descriptors for the model-facing markdown color extension.
 *
 * Pseudo-link grammar on link hrefs:
 *   #role:<name>    foreground role color (name: error, warn, ok, info, accent, muted)
 *   #bg:<name>      background role color
 *   #hex:<RRGGBB>   foreground exact hex color (six hex digits)
 *   #hexbg:<RRGGBB> background exact hex color
 *
 * Literal hex text:
 *   A standalone #RRGGBB token (six hex digits, word boundaries) colors itself.
 */

export const ROLE_NAMES = ["error", "warn", "ok", "info", "accent", "muted"] as const;

export type RoleName = (typeof ROLE_NAMES)[number];

export interface ColorDescriptor {
	channel: "fg" | "bg";
	kind: "role" | "hex";
	value: string;
}

const HEX_RE = /^[0-9a-fA-F]{6}$/;

const PREFIXES: ReadonlyArray<readonly [string, "fg" | "bg", "role" | "hex"]> = [
	["#role:", "fg", "role"],
	["#bg:", "bg", "role"],
	["#hex:", "fg", "hex"],
	["#hexbg:", "bg", "hex"],
];

function isRoleName(value: string): value is RoleName {
	return (ROLE_NAMES as readonly string[]).includes(value);
}

/** Parse a color descriptor from a link href. Returns undefined for non-color links. */
export function parseColorDescriptor(href: string): ColorDescriptor | undefined {
	for (const [prefix, channel, kind] of PREFIXES) {
		if (!href.startsWith(prefix)) continue;
		const value = href.slice(prefix.length);
		if (kind === "role") {
			if (!isRoleName(value)) return undefined;
			return { channel, kind, value };
		}
		if (!HEX_RE.test(value)) return undefined;
		return { channel, kind, value: value.toUpperCase() };
	}
	return undefined;
}

/**
 * Detect a standalone #RRGGBB literal.
 * Returns the six hex digits in uppercase, or undefined.
 */
export function parseHexLiteral(text: string): string | undefined {
	const match = text.match(/^#([0-9a-fA-F]{6})$/);
	return match ? match[1]!.toUpperCase() : undefined;
}

/**
 * Parse a comma-separated env list, trimming empties; undefined when unset.
 * Adopted by the root guard and the workspace guard. The security fence and
 * the git guard keep their own local copies (pre-existing); consolidating
 * them is a follow-up, not a lie in this header.
 */
export function envList(value: string | undefined): string[] | undefined {
	if (!value || value.length === 0) return undefined;
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

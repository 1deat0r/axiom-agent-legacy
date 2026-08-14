/**
 * Parse a comma-separated env list, trimming empties; undefined when unset.
 * Shared by the extensions that read comma-list config (fence, git guard,
 * root guard, workspace guard).
 */
export function envList(value: string | undefined): string[] | undefined {
	if (!value || value.length === 0) return undefined;
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

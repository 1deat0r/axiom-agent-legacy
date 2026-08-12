export function getAxiomUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `axiom/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}

/**
 * Discovery scope: coordination state for a project root lives under
 * `<home>/peers/<sha256(realpath(projectRoot))[:12]>/` — never inside the
 * repo tree, so agents never dirty git status while talking to each other.
 */

import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

export interface PeerScopeDeps {
	realpath?: (path: string) => string;
	mkdir?: (path: string) => void;
}

export function resolvePeerScopeDir(projectRoot: string, homeDir: string, deps: PeerScopeDeps = {}): string {
	const realpath = deps.realpath ?? ((path) => realpathSync(path));
	const mkdir = deps.mkdir ?? ((path) => mkdirSync(path, { recursive: true }));
	const key = createHash("sha256").update(realpath(projectRoot)).digest("hex").slice(0, 12);
	const dir = join(homeDir, "peers", key);
	mkdir(join(dir, "presence"));
	return dir;
}

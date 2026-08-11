/**
 * The axiom profile extension (port #8, ADR-0014 on the pi baseline).
 *
 * Rides the active profile's SOUL.md on the assembled system prompt — the
 * profile's identity survives the window by riding the prompt. Missing
 * SOUL.md (the default profile) leaves the prompt untouched.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { axiomHome } from "./registry.ts";

/** The delimited identity block appended to the system prompt. */
export function soulBlock(soul: string): string {
	return `\n\n<<<profile>>>\n${soul.trim()}\n<</profile>>>\n`;
}

/** Read a file, returning null when it does not exist. */
async function readOptional(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

export interface ProfileDeps {
	axiomHomeDir(): string;
	readText(path: string): Promise<string | null>;
}

export function createProfileExtension(deps?: Partial<ProfileDeps>): (pi: ExtensionAPI) => void {
	let axiomHomeDir = () => axiomHome();
	let readText: (path: string) => Promise<string | null> = (path) => readOptional(path);
	if (deps?.axiomHomeDir !== undefined) axiomHomeDir = deps.axiomHomeDir;
	if (deps?.readText !== undefined) readText = deps.readText;
	const resolved: ProfileDeps = { axiomHomeDir, readText };
	return (pi: ExtensionAPI) => {
		pi.on("before_agent_start", async (event, _ctx) => {
			const soul = await resolved.readText(join(resolved.axiomHomeDir(), "SOUL.md"));
			if (soul === null) return;
			return { systemPrompt: event.systemPrompt + soulBlock(soul) };
		});
	};
}

export default function axiomProfileExtension(pi: ExtensionAPI): void {
	createProfileExtension()(pi);
}

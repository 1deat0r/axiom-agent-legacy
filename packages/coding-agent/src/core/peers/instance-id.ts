/**
 * Stable instance identity: one ID per axiom home, generated once and stored
 * at `<home>/instance-id.json`. Reused across runs and by the CLI so messages
 * from the same machine carry the same identity.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PeerIdentity } from "./types.js";

const INSTANCE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export interface InstanceIdDeps {
	exists?: (path: string) => boolean;
	read?: (path: string) => string;
	write?: (path: string, data: string) => void;
	mkdir?: (path: string) => void;
	uuid?: () => string;
}

export function resolveInstanceIdFile(homeDir: string): string {
	return join(homeDir, "instance-id.json");
}

export function resolveInstanceId(homeDir: string, deps: InstanceIdDeps = {}): PeerIdentity {
	const file = resolveInstanceIdFile(homeDir);
	const exists = deps.exists ?? ((path) => existsSync(path));
	const read = deps.read ?? ((path) => readFileSync(path, "utf8"));
	const write = deps.write ?? ((path, data) => writeFileSync(path, data, "utf8"));
	const mkdir = deps.mkdir ?? ((path) => mkdirSync(path, { recursive: true }));
	const uuid = deps.uuid ?? randomUUID;

	let instanceId: string | undefined;
	if (exists(file)) {
		try {
			const parsed = JSON.parse(read(file)) as Partial<PeerIdentity>;
			if (typeof parsed.instanceId === "string" && INSTANCE_ID_PATTERN.test(parsed.instanceId)) {
				instanceId = parsed.instanceId;
			}
		} catch {
			instanceId = undefined;
		}
	}
	if (!instanceId) {
		instanceId = uuid();
		mkdir(dirname(file));
		write(file, JSON.stringify({ instanceId }));
	}
	return { instanceId, shortId: instanceId.slice(0, 8) };
}

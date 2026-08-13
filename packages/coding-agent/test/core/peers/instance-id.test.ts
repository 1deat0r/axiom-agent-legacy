import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInstanceId, resolveInstanceIdFile } from "../../../src/core/peers/instance-id.js";

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "peers-id-"));
}

describe("resolveInstanceId", () => {
	it("creates a stable ID file on first call", () => {
		const home = scratch();
		try {
			const a = resolveInstanceId(home);
			expect(a.instanceId).toMatch(/^[0-9a-f-]{36}$/);
			expect(a.shortId).toBe(a.instanceId.slice(0, 8));
			const b = resolveInstanceId(home);
			expect(b.instanceId).toBe(a.instanceId);
			expect(resolveInstanceIdFile(home)).toContain("instance-id.json");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("reuses an existing valid ID", () => {
		const home = scratch();
		try {
			writeFileSync(resolveInstanceIdFile(home), JSON.stringify({ instanceId: "abc12345-1234-1234-1234-123456789012" }));
			expect(resolveInstanceId(home).instanceId).toBe("abc12345-1234-1234-1234-123456789012");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("regenerates when the stored file is malformed", () => {
		const home = scratch();
		try {
			writeFileSync(resolveInstanceIdFile(home), "not json");
			expect(resolveInstanceId(home).instanceId).toMatch(/^[0-9a-f-]{36}$/);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

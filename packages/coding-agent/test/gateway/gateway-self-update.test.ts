import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryChannelIndex } from "../../src/gateway/channel-index.js";
import { fakeCompletionRunner } from "../../src/gateway/completion.js";
import { Gateway } from "../../src/gateway/gateway.js";
import type { UpdateShell } from "../../src/gateway/self-update.js";
import type { GatewayMessage, GatewayTransport } from "../../src/gateway/types.js";

/** A scriptable in-memory transport. */
function fakeTransport() {
	const sent: Array<{ to: string; text: string }> = [];
	let handler: ((msg: GatewayMessage) => void) | undefined;
	const t: GatewayTransport = {
		async connect() {},
		async disconnect() {},
		async send(to, text) {
			sent.push({ to: to.recipient, text });
		},
		onMessage(h) {
			handler = h;
		},
	};
	return { t, sent, push: (m: GatewayMessage) => handler?.(m) };
}

/** Scripted update shell: healthy fetch/merge/build behind-by-one. */
function healthyUpdateShell(failMerge = false) {
	const responses: Record<string, { code: number; stdout?: string; stderr?: string }> = {
		"git -C /repo rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n" },
		"git -C /repo status --porcelain": { code: 0, stdout: "" },
		"git -C /repo fetch origin": { code: 0 },
		"git -C /repo rev-parse HEAD": { code: 0, stdout: "aaa\n" },
		"git -C /repo rev-parse origin/main": { code: 0, stdout: "bbb\n" },
		"git -C /repo merge --ff-only origin/main": failMerge
			? { code: 1, stderr: "fatal: Not possible to fast-forward, aborting." }
			: { code: 0 },
		"npm run build": { code: 0 },
	};
	const shell: UpdateShell = {
		async run(cmd) {
			const r = responses[cmd.join(" ")];
			if (!r) throw new Error(`no fake response for: ${cmd.join(" ")}`);
			return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
		},
	};
	return shell;
}

async function home(prefix: string) {
	return mkdtemp(join(tmpdir(), prefix));
}

describe("Gateway self-update", () => {
	it("sends the reply before the deferred update, then restarts on success", async () => {
		const dir = await home("axiom-gw-upd-");
		try {
			const { t, sent, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			let restarts = 0;
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				update: { repoDir: "/repo" },
				updateShell: healthyUpdateShell(),
				restart: () => {
					restarts++;
				},
			});
			await g.start();
			push({ channelId: "+1", sender: "+1", text: "/update now", isCommand: true, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 50));
			expect(sent[0]?.text).toContain("checking for updates");
			expect(sent[1]?.text).toContain("aaa -> bbb");
			expect(sent[1]?.text).toContain("restarting");
			expect(restarts).toBe(1);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("never restarts when the update fails", async () => {
		const dir = await home("axiom-gw-upd-");
		try {
			const { t, sent, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			let restarts = 0;
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				update: { repoDir: "/repo" },
				updateShell: healthyUpdateShell(true),
				restart: () => {
					restarts++;
				},
			});
			await g.start();
			push({ channelId: "+1", sender: "+1", text: "/update now", isCommand: true, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 50));
			expect(sent.some((s) => s.text.includes("update failed"))).toBe(true);
			expect(sent.some((s) => s.text.includes("fast-forward"))).toBe(true);
			expect(restarts).toBe(0);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("replies not-configured when no update config is wired", async () => {
		const dir = await home("axiom-gw-upd-");
		try {
			const { t, sent, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
			});
			await g.start();
			push({ channelId: "+1", sender: "+1", text: "/update now", isCommand: true, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 20));
			expect(sent.some((s) => s.text.includes("not configured"))).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

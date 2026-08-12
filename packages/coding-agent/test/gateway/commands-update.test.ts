import { describe, expect, it } from "vitest";
import { dispatchCommand } from "../../src/gateway/commands/index.js";
import type { UpdateApply, UpdateCheck } from "../../src/gateway/self-update.js";
import type { GatewayCommandContext, GatewayUpdateApi } from "../../src/gateway/types.js";

function fakeApi(check: UpdateCheck, apply?: UpdateApply): GatewayUpdateApi {
	return {
		async check() {
			return check;
		},
		async apply() {
			if (!apply) throw new Error("apply not expected");
			return apply;
		},
	};
}

function ctx(
	extra: Partial<GatewayCommandContext> & { api?: GatewayUpdateApi },
): GatewayCommandContext & { delivered: string[] } {
	const delivered: string[] = [];
	return {
		profile: "default",
		axiomHomeDir: "/tmp",
		projectHome: "/tmp",
		...(extra.api ? { update: extra.api } : {}),
		deliver: async (text) => {
			delivered.push(text);
		},
		...extra,
		delivered,
	} as GatewayCommandContext & { delivered: string[] };
}

describe("/update command", () => {
	it("replies not-configured when the gateway lacks the update api", () => {
		const out = dispatchCommand("/update", ctx({}));
		expect(out).toContain("not configured");
	});

	it("check: replies 'checking' immediately and reports behind after the deferred action", async () => {
		const c = ctx({ api: fakeApi({ ok: true, current: "aaa", latest: "bbb", upToDate: false }) });
		const out = dispatchCommand("/update", c);
		expect(out).toContain("checking for updates");
		await c.afterReply?.();
		expect(c.delivered.join("\n")).toContain("aaa");
		expect(c.delivered.join("\n")).toContain("bbb");
		expect(c.delivered.join("\n")).toContain("/update now");
		expect(c.restartRequested).toBeUndefined();
	});

	it("check: reports up to date", async () => {
		const c = ctx({ api: fakeApi({ ok: true, current: "ccc", latest: "ccc", upToDate: true }) });
		dispatchCommand("/update", c);
		await c.afterReply?.();
		expect(c.delivered.join("\n")).toContain("up to date");
		expect(c.restartRequested).toBeUndefined();
	});

	it("check: reports a check failure and never restarts", async () => {
		const c = ctx({ api: fakeApi({ ok: false, error: "fetch failed: network down" }) });
		dispatchCommand("/update", c);
		await c.afterReply?.();
		expect(c.delivered.join("\n")).toContain("update failed");
		expect(c.restartRequested).toBeUndefined();
	});

	it("now, up to date: reports already-at-latest and does not restart", async () => {
		const c = ctx({ api: fakeApi({ ok: true, current: "ccc", latest: "ccc", upToDate: true }) });
		dispatchCommand("/update now", c);
		await c.afterReply?.();
		expect(c.delivered.join("\n")).toContain("already at latest");
		expect(c.restartRequested).toBeUndefined();
	});

	it("now, behind: applies, reports the jump, and requests a restart", async () => {
		const c = ctx({
			api: fakeApi(
				{ ok: true, current: "aaa", latest: "bbb", upToDate: false },
				{ ok: true, from: "aaa", to: "bbb" },
			),
		});
		dispatchCommand("/update now", c);
		await c.afterReply?.();
		expect(c.delivered.join("\n")).toContain("aaa -> bbb");
		expect(c.delivered.join("\n")).toContain("restarting");
		expect(c.restartRequested).toBe(true);
	});

	it("now, apply fails: reports the error, does not restart", async () => {
		const c = ctx({
			api: fakeApi(
				{ ok: true, current: "aaa", latest: "bbb", upToDate: false },
				{ ok: false, error: "merge not fast-forwardable" },
			),
		});
		dispatchCommand("/update now", c);
		await c.afterReply?.();
		expect(c.delivered.join("\n")).toContain("update failed");
		expect(c.delivered.join("\n")).toContain("merge");
		expect(c.restartRequested).toBeUndefined();
	});

	it("now, check fails: reports the error, does not restart", async () => {
		const c = ctx({ api: fakeApi({ ok: false, error: "worktree is not on main" }) });
		dispatchCommand("/update now", c);
		await c.afterReply?.();
		expect(c.delivered.join("\n")).toContain("update failed");
		expect(c.restartRequested).toBeUndefined();
	});
});

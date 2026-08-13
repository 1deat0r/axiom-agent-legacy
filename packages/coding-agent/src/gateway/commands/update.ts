/**
 * /update — gateway-local self-update (ADR-0034, never reaches the model).
 * `/update` fetches and reports current vs origin/main; `/update now`
 * fast-forwards and rebuilds, then restarts the gateway process (systemd
 * `Restart=always` brings it back on the new bundle). The heavy work runs in
 * a deferred post-reply action so the operator gets the acknowledgement
 * BEFORE the (slow) fetch/build; the restart is requested only on success —
 * on any failure the gateway keeps serving the old code.
 */
import type { GatewayCommand, GatewayCommandContext } from "../types.js";

const NOT_CONFIGURED =
	"self-update is not configured — set AXIOM_UPDATE_REPO or pass --update-repo <path> when starting `axiom gateway`.";
const CHECKING = "checking for updates…";

function short(sha: string): string {
	return sha.slice(0, 8);
}

/**
 * Deferred action for `/update [now]`: check (and for `now`, apply) after the
 * acknowledgement reply has been delivered. Outcomes are sent as follow-ups on
 * the same channel; restartRequested is set only when the update applied.
 */
function scheduleUpdate(ctx: GatewayCommandContext, apply: boolean): void {
	ctx.afterReply = async () => {
		const api = ctx.update;
		if (!api) return;
		const send = (text: string) => ctx.deliver?.(text);
		const check = await api.check();
		if (!check.ok) {
			await send(`update failed: ${check.error}`);
			return;
		}
		if (!apply) {
			await send(
				check.upToDate
					? `at ${short(check.current)}; up to date with origin/main`
					: `at ${short(check.current)}; latest is ${short(check.latest)} — send /update now to apply`,
			);
			return;
		}
		if (check.upToDate) {
			await send(`already at latest (${short(check.latest)}), nothing to do`);
			return;
		}
		const applied = await api.apply();
		if (!applied.ok) {
			await send(`update failed: ${applied.error} — still running ${short(check.current)}`);
			return;
		}
		// Record the "back online" notice BEFORE the reply + restart, so the
		// freshly-started gateway can announce it (ADR-0034 follow-up). It rides
		// the operator's channel so the confirmation lands where /update ran.
		if (ctx.channelId && ctx.restartNoticeStore) {
			ctx.restartNoticeStore.write({ sha: applied.to, channelId: ctx.channelId });
		}
		await send(`updated ${short(applied.from)} -> ${short(applied.to)}; restarting…`);
		ctx.restartRequested = true;
	};
}

export const updateCommand: GatewayCommand = {
	name: "update",
	summary: "self-update the gateway to the latest main and restart",
	handler(args: string[], ctx: GatewayCommandContext): string {
		if (!ctx.update) return NOT_CONFIGURED;
		const apply = args[0] === "now";
		scheduleUpdate(ctx, apply);
		return CHECKING;
	},
};

/**
 * /model — gateway-local hotswap of the agent's active model (never reaches
 * the model, ADR-0001). `/model` shows the current selection; `/model
 * <provider> <model>` (or provider/model, provider:model, or just <model>)
 * sets it; `/model clear` reverts to the profile's default. Persisted per
 * profile in the ActiveModelStore and injected as --provider/--model into
 * every subsequent completion.
 */
import type { ActiveModelStore } from "../active-model.js";
import { parseModelArg } from "../active-model.js";
import type { GatewayCommand, GatewayCommandContext } from "../types.js";

const USAGE =
	"/model                                   — show the active model\n" +
	"/model <model>                           — set model, keep the profile's provider\n" +
	"/model <provider> <model>                — set provider + model\n" +
	"/model <provider>/<model>  or  :         — same, one token\n" +
	"/model clear                             — revert to the profile default";

/** One-line status of the active model for a profile ("active model: ..."). */
export function describeActiveModel(store: ActiveModelStore | undefined, profile: string): string {
	if (!store) return "model switching is not wired in this gateway build.";
	const active = store.load();
	if (!active) return `no model override set — the '${profile}' profile uses its configured default model.`;
	const provider = active.provider ? `${active.provider}/` : "";
	return `active model: ${provider}${active.model}`;
}

export const modelCommand: GatewayCommand = {
	name: "model",
	summary: "hot-swap the active model for this gateway (no restart)",
	handler(args: string[], ctx: GatewayCommandContext): string {
		if (args.length === 0) {
			return `${describeActiveModel(ctx.modelStore, ctx.profile)}\n\n${USAGE}`;
		}
		if (args[0] === "clear") {
			ctx.modelStore?.clear();
			return "model override cleared — the profile will use its configured default model.";
		}
		const arg = args.join(" ");
		const parsed = parseModelArg(arg);
		if (!parsed)
			return `could not parse '${arg}' — expected 'provider model', 'provider/model', or 'model'.\n\n${USAGE}`;
		if (!ctx.modelStore) return "model switching is not wired in this gateway build.";
		ctx.modelStore.save(parsed);
		const provider = parsed.provider ? `${parsed.provider}/` : "";
		return `model set to ${provider}${parsed.model}. Next agent run will use it.`;
	},
};

/**
 * /cron — schedule agent runs and deliver their output to this channel
 * (automation spine, first step). Subcommands: list, add, rm. The jobs live in
 * the profile's cron store (AgentCronJobStore) and the gateway scheduler
 * boots each due run's prompt via the same headless completion seam as an
 * interactive reply, then sends the reply to the channel that created it.
 *
 * Schedule syntax is the store's own (parseAgentCronSchedule): "every 5m",
 * "in 3h", "at <ISO>", "@hourly"/@daily aliases, or a five-field cron
 * expression. The schedule is taken as the longest prefix of the arguments
 * that parses; the rest is the prompt.
 */
import { type AgentCronJob, isGatewayCronJob, parseAgentCronSchedule } from "../../core/cron-jobs.js";
import type { GatewayCommand, GatewayCommandContext } from "../types.js";

const USAGE = "usage: /cron list | /cron add <schedule> <prompt...> | /cron rm <id>";

const ACTIVE_LABEL: Record<AgentCronJob["status"], string> = {
	active: "",
	paused: " (paused)",
	completed: " (done)",
	cancelled: " (cancelled)",
};

/** Short, human-friendly relative "next run" text. */
function relativeNext(nextRunAt: string | undefined): string {
	if (!nextRunAt) return "—";
	const ms = Date.parse(nextRunAt) - Date.now();
	if (Number.isNaN(ms)) return "—";
	if (ms <= 0) return "due now";
	const m = Math.round(ms / 60_000);
	if (m < 60) return `in ~${m}m`;
	const h = Math.round(m / 60);
	if (h < 48) return `in ~${h}h`;
	return `in ~${Math.round(h / 24)}d`;
}

/** Take the longest schedule prefix of the args that parses; rest = prompt. */
function splitSchedulePrompt(args: string[], now = new Date()): { scheduleText: string; prompt: string } {
	let best: number | undefined;
	for (let k = 1; k <= Math.min(args.length, 5); k++) {
		const candidate = args.slice(0, k).join(" ");
		try {
			parseAgentCronSchedule(candidate, now);
			best = k;
		} catch {
			/* keep looking for a longer valid prefix */
		}
	}
	if (best === undefined) {
		throw new Error(
			"Unrecognized schedule. Try 'every 5m', 'in 3h', 'at <ISO date>', '@hourly', or five cron fields.",
		);
	}
	const scheduleText = args.slice(0, best).join(" ");
	const prompt = args.slice(best).join(" ").trim();
	if (!prompt) {
		throw new Error("A cron job needs a prompt after the schedule — e.g. /cron add every 5m summarize my costs");
	}
	return { scheduleText, prompt };
}

function list(ctx: GatewayCommandContext): string {
	if (!ctx.cron) return "cron is not wired on this gateway.";
	// The store file is shared with the daemon: only gateway-owned jobs
	// (cron-sourced with a channel) are /cron jobs. Heartbeats stay visible
	// only through `axiom daemon cron`.
	const jobs = ctx.cron
		.listJobs()
		.filter((j) => isGatewayCronJob(j) && (j.status === "active" || j.status === "paused"));
	if (jobs.length === 0) return "no scheduled cron jobs — try /cron add <schedule> <prompt>.";
	return jobs
		.map((j) => {
			const who = j.label ?? (j.prompt.length > 40 ? `${j.prompt.slice(0, 40)}…` : j.prompt);
			return `[${j.id.slice(0, 8)}] ${who} ${ACTIVE_LABEL[j.status]} — ${j.schedule.expression} — next ${relativeNext(j.nextRunAt)} — ran ${j.runCount}`;
		})
		.join("\n");
}

function add(args: string[], ctx: GatewayCommandContext): string {
	if (!ctx.cron) return "cron is not wired on this gateway.";
	if (args.length === 0) return USAGE;
	try {
		const channelId = ctx.channelId;
		if (!channelId) return "cron delivery needs a channel — this command must arrive on one.";
		const { scheduleText, prompt } = splitSchedulePrompt(args);
		const job = ctx.cron.addJob({ channelId, scheduleText, prompt });
		return `scheduled [${job.id.slice(0, 8)}] — ${job.schedule.expression} — first run ${relativeNext(job.nextRunAt)} — delivered to this channel. Stored as 'cron' in the profile store.`;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `could not schedule: ${message}`;
	}
}

function remove(args: string[], ctx: GatewayCommandContext): string {
	if (!ctx.cron) return "cron is not wired on this gateway.";
	const raw = args[0];
	if (!raw) return `${USAGE} — /cron rm <id>`;
	// Resolve only gateway-owned jobs: /cron rm must never cancel a heartbeat
	// or a daemon schedule job sharing the store.
	const jobs = ctx.cron.listJobs().filter((j) => isGatewayCronJob(j));
	const exact = jobs.find((j) => j.id === raw);
	const byPrefix = jobs.filter((j) => j.id.startsWith(raw));
	const target = exact ?? (byPrefix.length === 1 ? byPrefix[0] : undefined);
	if (!target) {
		return byPrefix.length > 1
			? `/${raw} matches ${byPrefix.length} jobs — use a longer id.`
			: `no cron job matching '${raw}'.`;
	}
	const removed = ctx.cron.removeJob(target.id);
	return removed ? `cancelled [${target.id.slice(0, 8)}].` : `could not cancel '${raw}'.`;
}

export const cronCommand: GatewayCommand = {
	name: "cron",
	summary: "Schedule agent runs and deliver output to this channel (add/list/rm)",
	handler(args, ctx) {
		const sub = args[0];
		if (!sub) return `${USAGE}\n\nSchemes: every 5m · in 3h · at <ISO> · @hourly · five cron fields.`;
		switch (sub) {
			case "list":
				return list(ctx);
			case "add":
				return add(args.slice(1), ctx);
			case "rm":
			case "remove":
				return remove(args.slice(1), ctx);
			case "help":
				return USAGE;
			default:
				return `unknown /cron subcommand '${sub}' — ${USAGE}`;
		}
	},
};

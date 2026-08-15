/**
 * Gateway cron manager (automation spine, first step): reuses the baseline
 * AgentCronJobStore + AgentCronScheduler to schedule agent runs and delivers
 * each run's output to the profile's gateway channel. A /cron job is a normal
 * cron-sourced job in the store carrying an extra channelId; the scheduler
 * boots the same headless completion seam as an interactive reply
 * (CliCompletionRunner) and transport.send()s the reply to that channel.
 *
 * Only jobs the gateway can actually deliver are run: a cron-sourced job with
 * a channelId. Heartbeat/rlm jobs sharing the same store file (or any job
 * without a channelId) are skipped — the gateway never boots a run it cannot
 * deliver.
 */
import { join } from "node:path";
import {
	type AgentCronJob,
	type AgentCronJobRunResult,
	AgentCronJobStore,
	AgentCronScheduler,
	isGatewayCronJob,
} from "../core/cron-jobs.js";
import { sessionIdForChannel } from "./completion.js";
import type { DeliveryLedger } from "./delivery-ledger.js";
import type { CompletionRunner, GatewayTransport } from "./types.js";

export interface GatewayCronOptions {
	/** Profile-scoped cron store path (e.g. getCronJobsPath(projectHome)). */
	storePath: string;
	completion: CompletionRunner;
	transport: GatewayTransport;
	profile: string;
	/** Profile home: cwd + session-file location for created jobs. */
	projectHome: string;
	/** Injectable clock for the scheduler (tests). */
	now?: () => Date;
	/** Delivery ledger (ADR-0022) so scheduled-run deliveries are recorded. */
	ledger?: DeliveryLedger;
	/** The active transport's name, recorded on each ledger entry. */
	transportName?: string;
}

/** The gateway's cron manager: store + scheduler + delivery. */
export class GatewayCron {
	private readonly store: AgentCronJobStore;
	private readonly scheduler: AgentCronScheduler;
	private readonly completion: CompletionRunner;
	private readonly transport: GatewayTransport;
	private readonly profile: string;
	private readonly projectHome: string;
	private readonly ledger: DeliveryLedger | undefined;
	private readonly transportName: string;
	private started = false;

	constructor(options: GatewayCronOptions) {
		this.store = new AgentCronJobStore(options.storePath);
		this.completion = options.completion;
		this.transport = options.transport;
		this.profile = options.profile;
		this.projectHome = options.projectHome;
		this.ledger = options.ledger;
		this.transportName = options.transportName ?? "cron";
		this.scheduler = new AgentCronScheduler(this.store, {
			now: options.now,
			// Claim only gateway-owned jobs (cron-sourced with a channel): the
			// store file is shared with the daemon, and a claim-all sweep would
			// eat a due heartbeat and advance its nextRunAt before the runJob
			// guard could skip it. The runJob guard stays as the backstop.
			claimFilter: (job) => isGatewayCronJob(job),
			runJob: (job) => this.runJob(job),
			onError: (job, error) => {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`cron job ${job.id} failed: ${message}`);
			},
		});
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.scheduler.start();
	}

	stop(): void {
		this.started = false;
		this.scheduler.stop();
	}

	/** Nudge the scheduler (after add/remove) so a new job is picked up now. */
	wake(): void {
		this.scheduler.wake();
	}

	/**
	 * Run every job due at `now` (default: now) and deliver its output. A thin
	 * seam over AgentCronScheduler.runDue — also usable by an operator to force
	 * a sweep, and by tests to drive delivery deterministically.
	 */
	runDue(now?: Date): Promise<number> {
		return this.scheduler.runDue(now);
	}

	listJobs(): AgentCronJob[] {
		return this.store.list();
	}

	addJob(input: { channelId: string; scheduleText: string; prompt: string; label?: string }): AgentCronJob {
		// Cron runs use their own namespaced session (cron-<channel>) so a due
		// job never boots a second agent process on the channel's interactive
		// session (process isolation, ADR-0014). Recurring runs of the same
		// channel's jobs still share that cron-namespaced context among
		// themselves; interactive turns use the distinct gw-<channel> session.
		const sessionId = `cron-${sessionIdForChannel(input.channelId)}`;
		const job = this.store.create({
			activeSessionId: sessionId,
			sessionId,
			sessionFile: join(this.projectHome, "sessions", `${sessionId}.jsonl`),
			cwd: this.projectHome,
			source: "cron",
			channelId: input.channelId,
			label: input.label,
			prompt: input.prompt,
			scheduleText: input.scheduleText,
		});
		this.wake();
		return job;
	}

	removeJob(id: string): AgentCronJob | undefined {
		const job = this.store.cancel(id);
		this.wake();
		return job;
	}

	/**
	 * Run one scheduled job and deliver its output: boot the completion for the
	 * job's prompt, then send the reply to the job's channel. Skips any job the
	 * gateway cannot deliver (no channelId or not cron-sourced). Delivery and
	 * completion errors never throw out of the scheduler lane — they are
	 * surfaced to the channel (completion error) or recorded by the scheduler
	 * (onError) and the dispatched run is still recorded by the store.
	 */
	async runJob(job: AgentCronJob): Promise<AgentCronJobRunResult | undefined> {
		if (!job.channelId || job.source !== "cron") {
			return "skipped";
		}
		const sessionId = job.sessionId ?? sessionIdForChannel(job.channelId);
		const result = await this.completion.runCompletion({
			sessionId,
			prompt: job.prompt,
			profile: { name: this.profile },
		});
		const body = result.error
			? `scheduled run failed: ${result.error}`
			: result.reply.length > 0
				? result.reply
				: "(no reply)";
		const recipient = { channelId: job.channelId, recipient: job.channelId };
		let ok = true;
		let error: string | undefined;
		try {
			await this.transport.send(recipient, body);
		} catch (cause) {
			ok = false;
			error = cause instanceof Error ? cause.message : String(cause);
		}
		// Scheduled-run delivery is recorded in the ledger like an interactive
		// reply, so the automation spine's output is continuous and auditable.
		this.ledger?.record({
			ts: Date.now(),
			transport: this.transportName,
			channel: job.channelId,
			recipient: job.channelId,
			chars: body.length,
			ok,
			error,
		});
		return "ran";
	}
}

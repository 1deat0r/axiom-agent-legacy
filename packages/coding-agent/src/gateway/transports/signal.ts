/**
 * Signal transport (ADR-0001): adapts the signal-cli binary to the gateway's
 * typed transport contract. signal-cli is operator-side (a linked device);
 * tests inject a fake SignalCli. Receiving polls `signal-cli receive`.
 */
import { execFile } from "node:child_process";
import { toGatewayMessage } from "../messages.js";
import type { GatewayMessage, GatewayRecipient, GatewayTransport } from "../types.js";

/** The parsed shape of one `signal-cli receive` JSON record. */
export interface SignalMessage {
	envelope: {
		source?: string;
		timestamp?: number;
		dataMessage?: { message?: string };
	};
}

/** The signal-cli boundary (a real client shells out; tests fake this). */
export interface SignalCli {
	send(recipient: string, text: string): Promise<void>;
	receive(): Promise<SignalMessage[]>;
}

/** Default SignalCli backed by the signal-cli binary. */
export class CliSignalClient implements SignalCli {
	constructor(
		private readonly bin: string = "signal-cli",
		private readonly account?: string,
		private readonly maxReceive: number = 8,
	) {}
	async send(recipient: string, text: string): Promise<void> {
		const args = ["send", "-m", text, recipient];
		if (this.account !== undefined) args.unshift("-a", this.account);
		await new Promise<void>((resolve, reject) => {
			execFile(this.bin, args, { encoding: "utf8" }, (err) => (err ? reject(err) : resolve()));
		});
	}
	async receive(): Promise<SignalMessage[]> {
		const args = ["receive", "--json", `--max-receive-attempts=${this.maxReceive}`];
		if (this.account !== undefined) args.unshift("-a", this.account);
		const out = await new Promise<string>((resolve, reject) => {
			execFile(this.bin, args, { encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
		});
		return out
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => {
				try {
					return JSON.parse(line) as SignalMessage;
				} catch {
					return null;
				}
			})
			.filter((m): m is SignalMessage => m !== null);
	}
}

/** Polling GatewayTransport over signal-cli. */
export class SignalTransport implements GatewayTransport {
	private intervalMs = 1000;
	private timer: ReturnType<typeof setInterval> | undefined;
	private handler: ((msg: GatewayMessage) => void) | undefined;
	private stopped = false;
	constructor(
		private readonly cli: SignalCli,
		private readonly selfNumber?: string,
	) {}
	connect(): Promise<void> {
		this.stopped = false;
		const poll = () => {
			if (this.stopped) return;
			void this.cli
				.receive()
				.then((messages) => {
					for (const raw of messages) this.deliver(raw);
				})
				.catch(() => {
					/* transient receive failure -> keep polling */
				});
		};
		poll();
		this.timer = setInterval(poll, this.intervalMs);
		return Promise.resolve();
	}
	disconnect(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		return Promise.resolve();
	}
	onMessage(handler: (msg: GatewayMessage) => void): void {
		this.handler = handler;
	}
	async send(to: GatewayRecipient, text: string): Promise<void> {
		await this.cli.send(to.recipient, text);
	}
	private deliver(raw: SignalMessage): void {
		if (!this.handler) return;
		const source = raw.envelope.source ?? this.selfNumber;
		if (!source) return;
		const text = raw.envelope.dataMessage?.message;
		if (text === undefined) return;
		this.handler(
			toGatewayMessage({
				channelId: source,
				sender: source,
				text,
				timestamp: raw.envelope.timestamp ?? Date.now(),
			}),
		);
	}
}

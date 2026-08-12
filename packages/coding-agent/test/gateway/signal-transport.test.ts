import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	CliSignalClient,
	type SignalCli,
	type SignalMessage,
	SignalTransport,
} from "../../src/gateway/transports/signal.js";

function fakeCli() {
	const sent: Array<{ recipient: string; text: string }> = [];
	const queue: SignalMessage[] = [];
	const cli: SignalCli = {
		async send(recipient, text) {
			sent.push({ recipient, text });
		},
		async receive() {
			return queue.splice(0, queue.length);
		},
	};
	return { cli, sent, queue };
}

describe("SignalTransport", () => {
	it("sends raw text to the recipient", async () => {
		const { cli, sent } = fakeCli();
		const t = new SignalTransport(cli);
		await t.connect();
		await t.send({ channelId: "+1", recipient: "+1" }, "hello");
		expect(sent).toEqual([{ recipient: "+1", text: "hello" }]);
		await t.disconnect();
	});
	it("delivers received messages to the handler (source as channel)", async () => {
		const { cli, queue } = fakeCli();
		queue.push({ envelope: { source: "+1", timestamp: 123, dataMessage: { message: "hi" } } });
		const t = new SignalTransport(cli);
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await new Promise((r) => setTimeout(r, 30));
		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({ channelId: "+1", sender: "+1", text: "hi", isCommand: false }),
		);
		await t.disconnect();
	});
	it("skips records without text or source", async () => {
		const { cli, queue } = fakeCli();
		queue.push(
			{ envelope: { source: "+1", timestamp: 1, dataMessage: {} } } as SignalMessage,
			{ envelope: { timestamp: 2, dataMessage: { message: "x" } } } as SignalMessage,
		);
		const t = new SignalTransport(cli);
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await new Promise((r) => setTimeout(r, 30));
		expect(handler).not.toHaveBeenCalled();
		await t.disconnect();
	});
});

describe("CliSignalClient", () => {
	it("invokes signal-cli send with the right argv (argv-check shim)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-cli-"));
		try {
			const outDir = join(dir, "out");
			await mkdir(outDir, { recursive: true });
			const shim = join(dir, "sig.mjs");
			await writeFile(
				shim,
				"#!/usr/bin/env node\n" +
					'import {writeFileSync} from "node:fs";\n' +
					`writeFileSync(process.env.SHIM_OUT, JSON.stringify(process.argv.slice(2)));\n`,
			);
			process.env.SHIM_OUT = join(outDir, "argv.json");
			const cli = new CliSignalClient(shim);
			await chmod(shim, 0o755);
			await cli.send("+1", "hello");
			const argv = JSON.parse(await readFile(join(outDir, "argv.json"), "utf8")) as string[];
			expect(argv).toEqual(["send", "-m", "hello", "+1"]);
		} finally {
			delete process.env.SHIM_OUT;
			await rm(dir, { recursive: true, force: true });
		}
	});
});

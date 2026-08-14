import { mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

let tempDir: string;
let root: AgentSession;

/** A stream that never delivers: the child agent hangs mid-generation. */
function hangingStream(): ReturnType<typeof createAssistantMessageEventStream> {
	return createAssistantMessageEventStream();
}

function createRootSession(streamFn: StreamFn): AgentSession {
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
	const settingsManager = SettingsManager.create(tempDir, tempDir);

	const agent = new Agent({
		convertToLlm,
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "",
			tools: [],
			thinkingLevel: "off",
		},
		streamFn,
	});

	return new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
		resourceLoader: createTestResourceLoader({}),
		rlmDepth: 0,
		rlmMaxDepth: 4,
		rlmSessionDir: join(tempDir, "rlm-root"),
	});
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await sleep(10);
	}
}

/** Backdate every activity file in a child session dir (direct files + harness/). */
function backdateSessionDir(sessionDir: string, ageMs: number): void {
	const now = Date.now();
	const backdate = (path: string) => {
		try {
			utimesSync(path, new Date(now - ageMs), new Date(now - ageMs));
		} catch {
			// Racing the child's writes is fine: the next sweep re-reads mtimes.
		}
	};
	// Simulate "writes stopped ageMs ago": age every existing file, then add a
	// sentinel that is also aged, so nothing in the dir looks recent.
	for (const entry of readdirSync(sessionDir)) {
		backdate(join(sessionDir, entry));
	}
	try {
		for (const entry of readdirSync(join(sessionDir, "harness"))) {
			backdate(join(sessionDir, "harness", entry));
		}
	} catch {
		// No harness dir yet.
	}
	writeFileSync(join(sessionDir, "sentinel.txt"), "activity marker");
	backdate(join(sessionDir, "sentinel.txt"));
}

beforeEach(() => {
	tempDir = mkdirSync(join(tmpdir(), `axiom-rlm-stall-${Date.now()}-${Math.random().toString(36).slice(2)}`), {
		recursive: true,
	}) as string;
	root = createRootSession(hangingStream);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await root.disposeAsync().catch(() => undefined);
	rmSync(tempDir, { recursive: true, force: true });
});

describe("RLM child stall marking", () => {
	it("marks a running child stalled when its session dir has had no writes", async () => {
		vi.stubEnv("AXIOM_RLM_CHILD_STALL_MS", "600000");
		const spawned = await root.runRlmChild("stall me");
		const childId = spawned.rlm_child_id;
		await waitFor(() => root.getRlmChildRunStatus(childId) === "running");

		const before = await root.listRlmSubagents();
		expect(before.subagents.find((s) => s.rlm_child_id === childId)?.status).toBe("running");

		backdateSessionDir(spawned.session_dir, 20 * 60_000);
		const stalled = await root.listRlmSubagents(Date.now());
		expect(stalled.subagents.find((s) => s.rlm_child_id === childId)?.status).toBe("stalled");
	});

	it("returns to running when the child writes again", async () => {
		vi.stubEnv("AXIOM_RLM_CHILD_STALL_MS", "600000");
		const spawned = await root.runRlmChild("stall me then wake up");
		const childId = spawned.rlm_child_id;
		await waitFor(() => root.getRlmChildRunStatus(childId) === "running");

		backdateSessionDir(spawned.session_dir, 20 * 60_000);
		expect((await root.listRlmSubagents(Date.now())).subagents.find((s) => s.rlm_child_id === childId)?.status).toBe(
			"stalled",
		);

		writeFileSync(join(spawned.session_dir, "wake.txt"), "woke up");
		expect((await root.listRlmSubagents(Date.now())).subagents.find((s) => s.rlm_child_id === childId)?.status).toBe(
			"running",
		);
	});

	it("honors the env knob for the stall threshold", async () => {
		vi.stubEnv("AXIOM_RLM_CHILD_STALL_MS", "30000");
		const spawned = await root.runRlmChild("stall me faster");
		const childId = spawned.rlm_child_id;
		await waitFor(() => root.getRlmChildRunStatus(childId) === "running");

		backdateSessionDir(spawned.session_dir, 60_000);
		expect((await root.listRlmSubagents(Date.now())).subagents.find((s) => s.rlm_child_id === childId)?.status).toBe(
			"stalled",
		);
	});

	it("never marks a child stalled when the knob is zero", async () => {
		vi.stubEnv("AXIOM_RLM_CHILD_STALL_MS", "0");
		const spawned = await root.runRlmChild("stall me, disabled watchdog");
		const childId = spawned.rlm_child_id;
		await waitFor(() => root.getRlmChildRunStatus(childId) === "running");

		backdateSessionDir(spawned.session_dir, 20 * 60_000);
		expect((await root.listRlmSubagents(Date.now())).subagents.find((s) => s.rlm_child_id === childId)?.status).toBe(
			"running",
		);
	});

	it("fails a stalled child turn with an error recorded in the child session", async () => {
		vi.useFakeTimers();
		try {
			vi.stubEnv("AXIOM_STREAM_STALL_TIMEOUT_MS", "1000");
			vi.stubEnv("AXIOM_STREAM_STALL_MAX_ATTEMPTS", "2");
			const spawned = await root.runRlmChild("hang forever");
			const childId = spawned.rlm_child_id;
			// Drive admission and the child turn; each attempt stalls at 1s.
			for (let i = 0; i < 24; i++) {
				await vi.advanceTimersByTimeAsync(250);
			}
			const child = root.getRlmChildSession(childId);
			expect(child).toBeDefined();
			expect(child && "sessionFile" in child ? child.sessionFile : undefined).toBeDefined();
			const sessionText = readFileSync(child!.sessionFile!, "utf8");
			expect(sessionText).toMatch(/stalled/i);
			const last = [...child!.messages].reverse().find((m) => m.role === "assistant");
			expect(last && "stopReason" in last ? last.stopReason : undefined).toBe("error");
			expect(last && "errorMessage" in last ? String(last.errorMessage) : "").toMatch(/stalled/i);
			// The child run settles into the retained registry as completed.
			expect((await root.listRlmSubagents()).subagents.find((entry) => entry.rlm_child_id === childId)?.status).toBe(
				"completed",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("re-emits the child snapshot as stalled on the refresh cadence", async () => {
		vi.useFakeTimers();
		try {
			vi.stubEnv("AXIOM_RLM_CHILD_STALL_MS", "40000");
			const spawned = await root.runRlmChild("stall me, snapshot please");
			const childId = spawned.rlm_child_id;
			const snapshots: Array<{ status: string }> = [];
			root.subscribe((event) => {
				if (event.type === "rlm_child_update" && event.child.id === childId) {
					snapshots.push({ status: event.child.status });
				}
			});
			// Admission is asynchronous: drive the detached task with the fake clock.
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);
			expect(root.getRlmChildRunStatus(childId)).toBe("running");

			backdateSessionDir(spawned.session_dir, 20 * 60_000);
			// Refresh cadence for a 40s threshold is 10s.
			await vi.advanceTimersByTimeAsync(10_000);
			expect(snapshots.some((snapshot) => snapshot.status === "stalled")).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

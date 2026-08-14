import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fromAny } from "@total-typescript/shoehorn";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";
import {
	buildGcCollectCode,
	buildGcPressureCode,
	crossesCollectThreshold,
	DEFAULT_GC_MAX_TRACKED_OBJECTS,
	DEFAULT_GC_MAX_UNCOLLECTED_OBJECTS,
	GC_RESULT_MARKER,
	parseGcCollectResult,
	parseGcPressureResult,
	resolveGcOptionsFromEnv,
	sanitizeGcOptions,
} from "../src/core/kernel/kernel-gc.js";

describe("buildGcPressureCode / buildGcCollectCode", () => {
	it("emits a cell that calls the runtime gc module and prints the marker", () => {
		const code = buildGcPressureCode(false);
		expect(code).toContain("from rlm import gc");
		expect(code).toContain("measure_pressure");
		expect(code).toContain(GC_RESULT_MARKER);
		expect(code).not.toContain("detailed=True");
		const detailed = buildGcPressureCode(true);
		expect(detailed).toContain("detailed=True");
	});

	it("collect cell runs a pass with detailed before/after pressure", () => {
		const code = buildGcCollectCode();
		expect(code).toContain("from rlm import gc");
		expect(code).toContain("collect(detailed=True)");
		expect(code).toContain(GC_RESULT_MARKER);
	});
});

describe("parseGcPressureResult", () => {
	it("parses a cheap pressure payload", () => {
		const stdout = `${GC_RESULT_MARKER}${JSON.stringify({
			uncollected_objects: 5,
			generation_counts: [2, 1, 2],
			collected_objects: 100,
			uncollectable_objects: 0,
		})}\n`;
		expect(parseGcPressureResult(stdout)).toEqual({
			uncollectedObjects: 5,
			generationCounts: [2, 1, 2],
			collectedObjects: 100,
			uncollectableObjects: 0,
		});
	});

	it("parses a detailed pressure payload", () => {
		const stdout = `${GC_RESULT_MARKER}${JSON.stringify({
			uncollected_objects: 5,
			generation_counts: [2, 1, 2],
			collected_objects: 100,
			uncollectable_objects: 0,
			tracked_objects: 900,
			estimated_bytes: 1234,
			user_objects: 12,
			user_bytes: 99,
		})}\n`;
		const result = parseGcPressureResult(stdout);
		expect(result?.trackedObjects).toBe(900);
		expect(result?.estimatedBytes).toBe(1234);
		expect(result?.userObjects).toBe(12);
		expect(result?.userBytes).toBe(99);
	});

	it("ignores output printed before the marker line", () => {
		const stdout = `noise\n${GC_RESULT_MARKER}${JSON.stringify({
			uncollected_objects: 1,
			generation_counts: [1, 0, 0],
			collected_objects: 0,
			uncollectable_objects: 0,
		})}`;
		expect(parseGcPressureResult(stdout)?.uncollectedObjects).toBe(1);
	});

	it("returns null when the marker is absent, on error payloads, and on malformed json", () => {
		expect(parseGcPressureResult("no marker")).toBeNull();
		expect(parseGcPressureResult(`${GC_RESULT_MARKER}${JSON.stringify({ error: "boom" })}`)).toBeNull();
		expect(parseGcPressureResult(`${GC_RESULT_MARKER}{not json`)).toBeNull();
		expect(parseGcPressureResult(`${GC_RESULT_MARKER}${JSON.stringify({})}`)).toBeNull();
	});
});

describe("parseGcCollectResult", () => {
	it("parses a collect result with before/after pressure", () => {
		const pressure = {
			uncollectedObjects: 7,
			generationCounts: [4, 2, 1],
			collectedObjects: 1,
			uncollectableObjects: 0,
			trackedObjects: 500,
		};
		const rawPressure = {
			uncollected_objects: 7,
			generation_counts: [4, 2, 1],
			collected_objects: 1,
			uncollectable_objects: 0,
			tracked_objects: 500,
		};
		const stdout = `${GC_RESULT_MARKER}${JSON.stringify({
			collected: 42,
			uncollectable: 0,
			before: rawPressure,
			after: { ...rawPressure, tracked_objects: 400 },
		})}\n`;
		expect(parseGcCollectResult(stdout)).toEqual({
			collected: 42,
			uncollectable: 0,
			before: pressure,
			after: { ...pressure, trackedObjects: 400 },
		});
	});

	it("returns null on marker-less, error, or malformed payloads", () => {
		expect(parseGcCollectResult("nothing")).toBeNull();
		expect(parseGcCollectResult(`${GC_RESULT_MARKER}${JSON.stringify({ error: "x" })}`)).toBeNull();
		expect(parseGcCollectResult(`${GC_RESULT_MARKER}{broken`)).toBeNull();
		expect(parseGcCollectResult(`${GC_RESULT_MARKER}${JSON.stringify({ collected: 3 })}`)).toBeNull();
	});
});

describe("resolveGcOptionsFromEnv", () => {
	it("is off by default (no env vars set)", () => {
		expect(resolveGcOptionsFromEnv({})).toBeUndefined();
	});

	it("enables per-N-cell checks from AXIOM_GC_CHECK_EVERY_N_CELLS", () => {
		expect(resolveGcOptionsFromEnv({ AXIOM_GC_CHECK_EVERY_N_CELLS: "5" })).toEqual({
			checkEveryNCells: 5,
			maxUncollectedObjects: DEFAULT_GC_MAX_UNCOLLECTED_OBJECTS,
			maxTrackedObjects: DEFAULT_GC_MAX_TRACKED_OBJECTS,
		});
	});

	it("reads the uncollected and tracked threshold overrides", () => {
		expect(
			resolveGcOptionsFromEnv({
				AXIOM_GC_CHECK_EVERY_N_CELLS: "2",
				AXIOM_GC_MAX_UNCOLLECTED_OBJECTS: "1234",
				AXIOM_GC_MAX_TRACKED_OBJECTS: "4321",
			}),
		).toEqual({ checkEveryNCells: 2, maxUncollectedObjects: 1234, maxTrackedObjects: 4321 });
	});

	it("ignores zero and malformed values", () => {
		expect(resolveGcOptionsFromEnv({ AXIOM_GC_CHECK_EVERY_N_CELLS: "0" })).toBeUndefined();
		expect(resolveGcOptionsFromEnv({ AXIOM_GC_CHECK_EVERY_N_CELLS: "nope" })).toBeUndefined();
		expect(
			resolveGcOptionsFromEnv({
				AXIOM_GC_CHECK_EVERY_N_CELLS: "3",
				AXIOM_GC_MAX_UNCOLLECTED_OBJECTS: "-2",
				AXIOM_GC_MAX_TRACKED_OBJECTS: "nope",
			}),
		).toEqual({
			checkEveryNCells: 3,
			maxUncollectedObjects: DEFAULT_GC_MAX_UNCOLLECTED_OBJECTS,
			maxTrackedObjects: DEFAULT_GC_MAX_TRACKED_OBJECTS,
		});
	});
});

describe("crossesCollectThreshold", () => {
	it("is false below both defaults", () => {
		expect(
			crossesCollectThreshold(
				{ uncollectedObjects: 300, generationCounts: [0, 0, 0], collectedObjects: 0, uncollectableObjects: 0 },
				{
					maxUncollectedObjects: DEFAULT_GC_MAX_UNCOLLECTED_OBJECTS,
					maxTrackedObjects: DEFAULT_GC_MAX_TRACKED_OBJECTS,
				},
			),
		).toBe(false);
	});

	it("fires on tracked objects past the default even when the cheap counter is low", () => {
		// The cheap metric is structurally capped near 720; the tracked count
		// is the reachable default trigger. This is the host-side mirror of
		// the in-kernel periodic check.
		expect(
			crossesCollectThreshold(
				{
					uncollectedObjects: 620,
					generationCounts: [600, 10, 10],
					collectedObjects: 0,
					uncollectableObjects: 0,
					trackedObjects: DEFAULT_GC_MAX_TRACKED_OBJECTS + 1,
				},
				{
					maxUncollectedObjects: DEFAULT_GC_MAX_UNCOLLECTED_OBJECTS,
					maxTrackedObjects: DEFAULT_GC_MAX_TRACKED_OBJECTS,
				},
			),
		).toBe(true);
	});

	it("fires on the cheap counter at the configured threshold", () => {
		expect(
			crossesCollectThreshold(
				{ uncollectedObjects: 2000, generationCounts: [0, 0, 0], collectedObjects: 0, uncollectableObjects: 0 },
				{ maxUncollectedObjects: 2000, maxTrackedObjects: DEFAULT_GC_MAX_TRACKED_OBJECTS },
			),
		).toBe(true);
	});

	it("requires a present tracked count before comparing it", () => {
		expect(
			crossesCollectThreshold(
				{ uncollectedObjects: 10, generationCounts: [0, 0, 0], collectedObjects: 0, uncollectableObjects: 0 },
				{ maxUncollectedObjects: 100, maxTrackedObjects: 5 },
			),
		).toBe(false);
	});
});

describe("sanitizeGcOptions", () => {
	it("keeps valid options", () => {
		expect(sanitizeGcOptions({ checkEveryNCells: 5, maxUncollectedObjects: 10 })).toEqual({
			checkEveryNCells: 5,
			maxUncollectedObjects: 10,
		});
	});

	it("drops options with an invalid checkEveryNCells", () => {
		expect(sanitizeGcOptions({ checkEveryNCells: 0 })).toBeUndefined();
		expect(sanitizeGcOptions({ checkEveryNCells: 1.5 })).toBeUndefined();
		expect(sanitizeGcOptions({ checkEveryNCells: Number.POSITIVE_INFINITY })).toBeUndefined();
		expect(sanitizeGcOptions(undefined)).toBeUndefined();
	});

	it("drops non-finite thresholds", () => {
		expect(sanitizeGcOptions({ checkEveryNCells: 2, maxUncollectedObjects: Number.NaN })).toEqual({
			checkEveryNCells: 2,
		});
	});
});

/** Find a python that can launch an ipykernel with the gc-aware runtime, or null to skip. */
function resolveKernelPython(): string | null {
	const candidates = [
		process.env.AXIOM_KERNEL_PYTHON,
		join(homedir(), ".axiom", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import ipykernel, dill; import rlm.gc; rlm.gc.measure_pressure()"], {
			encoding: "utf8",
		});
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveKernelPython();
const describeIfKernel = python ? describe : describe.skip;

describeIfKernel("kernel gc pressure and collect (real kernel)", { tags: ["kernel-heavy"] }, () => {
	let dir = "";
	// Direct spawn keeps these tests deterministic: the forkserver path has a
	// pre-existing intermittent first-execute hang (see kernel-state-roundtrip
	// flakes) unrelated to GC, and is covered by kernel-fork-server.test.ts.
	// Same convention as ipython-provisioner.test.ts.
	const savedForkFlag = process.env.AXIOM_KERNEL_FORKSERVER;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "axiom-gc-"));
		process.env.AXIOM_KERNEL_FORKSERVER = "0";
	});

	afterAll(() => {
		if (savedForkFlag === undefined) delete process.env.AXIOM_KERNEL_FORKSERVER;
		else process.env.AXIOM_KERNEL_FORKSERVER = savedForkFlag;
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	function newManager(options: { gc?: { checkEveryNCells?: number; maxUncollectedObjects?: number } } = {}) {
		return new KernelManager({
			python: fromAny<string, unknown>(python),
			cwd: dir,
			...options,
		});
	}

	it("reports pressure and collects a leaking namespace back down (leak scenario)", async () => {
		const manager = newManager();
		try {
			// Lists (unlike bytearrays) are tracked by the cyclic GC, so a leak of
			// them shows up in trackedObjects as well as the user-namespace closure.
			// The self-reference makes the payload a true cycle: after del it is
			// unreachable but survives refcounting, so only a GC pass can free it.
			await manager.execute("data = [[0] * 1024 for _ in range(5000)]; data.append(data)");

			// Detailed pressure: cheap reads don't carry user/tracked counts.
			const before = await manager.gcPressure(true);
			expect(before).not.toBeNull();
			expect(before?.uncollectedObjects).toBeGreaterThan(0);
			// The live namespace owns the 5000 bytearrays + their list.
			expect(before?.userObjects ?? 0).toBeGreaterThan(5000);

			// IPython caches every cell result in Out AND in the _, __, ___ history;
			// clearing them releases the output-history references or the "leak"
			// stays alive forever.
			await manager.execute("del data; Out.clear(); _ = __ = ___ = None");
			const collected = await manager.collectGarbage();
			expect(collected).not.toBeNull();
			expect(collected?.collected).toBeGreaterThan(0);

			const after = await manager.gcPressure(true);
			expect(after).not.toBeNull();
			// The namespace leak is gone: pressure dropped by at least the payload.
			expect((before?.userObjects ?? 0) - (after?.userObjects ?? 0)).toBeGreaterThan(5000);
			expect((before?.trackedObjects ?? 0) - (after?.trackedObjects ?? 0)).toBeGreaterThan(5000);
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("attaches pressure to user cell results when per-N checks are enabled", async () => {
		const manager = newManager({ gc: { checkEveryNCells: 1 } });
		try {
			const result = await manager.execute("x = [1, 2, 3]");
			expect(result.status).toBe("ok");
			expect(result.gc).toBeDefined();
			expect(result.gc?.pressure.uncollectedObjects).toBeGreaterThanOrEqual(0);
			// Under the default threshold no collect pass runs.
			expect(result.gc?.collect).toBeUndefined();
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("runs a collect pass automatically when pressure crosses the configured threshold", async () => {
		const manager = newManager({ gc: { checkEveryNCells: 1, maxUncollectedObjects: 0 } });
		try {
			// A self-referential cycle dropped at cell end: unreachable but
			// refcount-surviving, so the auto-collect pass must free it.
			const result = await manager.execute(
				"def _g():\n    a = [[0] * 64 for _ in range(2000)]\n    a.append(a)\n_g()",
			);
			expect(result.status).toBe("ok");
			// The check ran and the zero threshold forced a collect pass. The exact
			// collected count is the leak-scenario test's contract; here we assert
			// the pass ran and pressure did not go up.
			expect(result.gc?.pressure).toBeDefined();
			expect(result.gc?.collect).toBeDefined();
			expect(result.gc?.collect?.after.uncollectedObjects ?? 0).toBeLessThanOrEqual(
				result.gc?.collect?.before.uncollectedObjects ?? Number.POSITIVE_INFINITY,
			);
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("collects with DEFAULT thresholds when tracked objects cross the default", async () => {
		const manager = newManager({ gc: { checkEveryNCells: 1 } });
		try {
			// A bounded burst held alive in the namespace (so automatic
			// collections cannot free it mid-test) crosses the default
			// tracked threshold. Lists are GC-tracked (bytearrays are not).
			const burst = await manager.execute("_burst = [[0] * 8 for _ in range(300000)]; _burst.append(_burst)");
			expect(burst.status).toBe("ok");
			// The next user cell's per-N check (N=1) must see tracked objects
			// above DEFAULT_GC_MAX_TRACKED_OBJECTS and run a collect pass.
			const result = await manager.execute("y = 1");
			expect(result.status).toBe("ok");
			expect(result.gc?.pressure).toBeDefined();
			expect(result.gc?.pressure.trackedObjects).toBeGreaterThan(DEFAULT_GC_MAX_TRACKED_OBJECTS);
			expect(result.gc?.collect).toBeDefined();
		} finally {
			await manager.execute("_burst.clear(); import gc as _g; _g.collect()");
			await manager.dispose();
		}
	}, 60_000);

	it("leaves results gc-less when per-N checks are off (no regression)", async () => {
		const manager = newManager();
		try {
			const result = await manager.execute("z = 1");
			expect(result.status).toBe("ok");
			expect(result.gc).toBeUndefined();
			// Internal synthetic cells (pressure/collect) also never attach gc data.
			const pressure = await manager.gcPressure();
			expect(pressure).not.toBeNull();
		} finally {
			await manager.dispose();
		}
	}, 60_000);
});

// Garbage-collection pressure for the persistent IPython kernel, mirroring
// state-snapshot.ts: synthetic internal cells call the rlm.gc module installed
// with axiom-runtime and print one marker line the host parses.
//
// The threshold-based pass itself runs in-kernel (rlm.gc installs an IPython
// post_execute hook at bootstrap); this module is the host-side surface:
// explicit pressure reads, explicit collect passes, and the opt-in per-N-cell
// metadata check that attaches pressure (and, past a threshold, a collect) to
// user cell results.

/** Marker the Python helpers print so the host can recover the JSON result line. */
export const GC_RESULT_MARKER = "__AXIOM_KERNEL_GC__";

/** Env knobs shared with the runtime (rlm.gc.resolve_thresholds). */
export const GC_CHECK_EVERY_N_CELLS_ENV = "AXIOM_GC_CHECK_EVERY_N_CELLS";
export const GC_MAX_UNCOLLECTED_OBJECTS_ENV = "AXIOM_GC_MAX_UNCOLLECTED_OBJECTS";

/** Defaults must match axiom-runtime/src/rlm/gc.py. */
export const DEFAULT_GC_MAX_UNCOLLECTED_OBJECTS = 100_000;
export const DEFAULT_GC_MAX_TRACKED_OBJECTS = 1_000_000;
export const DEFAULT_GC_MAX_ESTIMATED_BYTES = 1 << 30; // 1 GiB

/** One snapshot of kernel GC pressure (cheap by default; detailed keys optional). */
export interface GcPressure {
	/** Sum of the stdlib GC's per-generation counters since the last collection. */
	uncollectedObjects: number;
	generationCounts: number[];
	collectedObjects: number;
	uncollectableObjects: number;
	/** Present only on detailed measurements. */
	trackedObjects?: number;
	estimatedBytes?: number;
	userObjects?: number;
	userBytes?: number;
}

/** Result of one explicit GC pass with before/after pressure. */
export interface GcCollectResult {
	collected: number;
	uncollectable: number;
	before: GcPressure;
	after: GcPressure;
}

/** Opt-in host-side GC metadata policy. Off unless enabled. */
export interface KernelGcOptions {
	/**
	 * After every N successful user cells, attach a pressure snapshot to that
	 * cell's result, and run a collect pass when pressure crosses the threshold.
	 * Default: off (no extra cells, ipython execution unchanged).
	 */
	checkEveryNCells?: number;
	/** Overrides AXIOM_GC_MAX_UNCOLLECTED_OBJECTS. */
	maxUncollectedObjects?: number;
}

function parsePositiveIntEnv(raw: string | undefined): number | undefined {
	if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
	const value = Number.parseInt(raw.trim(), 10);
	return value > 0 ? value : undefined;
}

/** Resolve the opt-in GC metadata policy from env vars; off when unset/invalid. */
export function resolveGcOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): KernelGcOptions | undefined {
	const checkEveryNCells = parsePositiveIntEnv(env[GC_CHECK_EVERY_N_CELLS_ENV]);
	if (!checkEveryNCells) return undefined;
	const maxUncollectedObjects =
		parsePositiveIntEnv(env[GC_MAX_UNCOLLECTED_OBJECTS_ENV]) ?? DEFAULT_GC_MAX_UNCOLLECTED_OBJECTS;
	return { checkEveryNCells, maxUncollectedObjects };
}

/** Render a JS string as a Python string literal (JSON's escaping is a valid subset). */
function pyStr(value: string): string {
	return JSON.stringify(value);
}

/**
 * Python for a synthetic cell that measures pressure and prints one marker line.
 * Builtins are aliased so a user-namespace shadow of print/json can't break it.
 */
export function buildGcPressureCode(detailed: boolean): string {
	return `
def _prime_agent_gc_pressure():
    import builtins as _b, json
    try:
        from rlm import gc as _axiom_gc
    except _b.Exception as _err:
        _b.print(${pyStr(GC_RESULT_MARKER)} + json.dumps({"error": "rlm.gc unavailable: " + _b.str(_err)}))
        return
    try:
        _pressure = _axiom_gc.measure_pressure(detailed=${detailed ? "True" : "False"})
    except _b.Exception as _err:
        _b.print(${pyStr(GC_RESULT_MARKER)} + json.dumps({"error": _b.str(_err)}))
        return
    _b.print(${pyStr(GC_RESULT_MARKER)} + json.dumps(_pressure))


try:
    _prime_agent_gc_pressure()
finally:
    del _prime_agent_gc_pressure
`.trim();
}

/**
 * Python for a synthetic cell that runs a full GC pass and reports before/after
 * detailed pressure, so callers can see what the pass actually freed.
 */
export function buildGcCollectCode(): string {
	return `
def _prime_agent_gc_collect():
    import builtins as _b, json
    try:
        from rlm import gc as _axiom_gc
    except _b.Exception as _err:
        _b.print(${pyStr(GC_RESULT_MARKER)} + json.dumps({"error": "rlm.gc unavailable: " + _b.str(_err)}))
        return
    try:
        _result = _axiom_gc.collect(detailed=True)
    except _b.Exception as _err:
        _b.print(${pyStr(GC_RESULT_MARKER)} + json.dumps({"error": _b.str(_err)}))
        return
    _b.print(${pyStr(GC_RESULT_MARKER)} + json.dumps(_result))


try:
    _prime_agent_gc_collect()
finally:
    del _prime_agent_gc_collect
`.trim();
}

interface RawGcPressure {
	uncollected_objects?: unknown;
	generation_counts?: unknown;
	collected_objects?: unknown;
	uncollectable_objects?: unknown;
	tracked_objects?: unknown;
	estimated_bytes?: unknown;
	user_objects?: unknown;
	user_bytes?: unknown;
	error?: unknown;
}

interface RawGcCollect {
	collected?: unknown;
	uncollectable?: unknown;
	before?: unknown;
	after?: unknown;
	error?: unknown;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNumberArray(value: unknown): number[] {
	return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];
}

/** Pull the marker line out of cell stdout and parse it, or null if absent/invalid. */
function parseMarkerLine<T>(stdout: string): T | null {
	const index = stdout.lastIndexOf(GC_RESULT_MARKER);
	if (index === -1) return null;
	const rest = stdout.slice(index + GC_RESULT_MARKER.length);
	const line = rest.split("\n", 1)[0]?.trim();
	if (!line) return null;
	try {
		return JSON.parse(line) as T;
	} catch {
		return null;
	}
}

function parseRawPressure(raw: unknown): GcPressure | null {
	if (!raw || typeof raw !== "object") return null;
	const entry = raw as RawGcPressure;
	if (entry.error !== undefined) return null;
	const uncollectedObjects = asNumber(entry.uncollected_objects);
	if (uncollectedObjects === undefined) return null;
	const pressure: GcPressure = {
		uncollectedObjects,
		generationCounts: asNumberArray(entry.generation_counts),
		collectedObjects: asNumber(entry.collected_objects) ?? 0,
		uncollectableObjects: asNumber(entry.uncollectable_objects) ?? 0,
	};
	const trackedObjects = asNumber(entry.tracked_objects);
	if (trackedObjects !== undefined) pressure.trackedObjects = trackedObjects;
	const estimatedBytes = asNumber(entry.estimated_bytes);
	if (estimatedBytes !== undefined) pressure.estimatedBytes = estimatedBytes;
	const userObjects = asNumber(entry.user_objects);
	if (userObjects !== undefined) pressure.userObjects = userObjects;
	const userBytes = asNumber(entry.user_bytes);
	if (userBytes !== undefined) pressure.userBytes = userBytes;
	return pressure;
}

/** Pressure snapshot from a synthetic cell's marker line, or null. */
export function parseGcPressureResult(stdout: string): GcPressure | null {
	return parseRawPressure(parseMarkerLine<unknown>(stdout));
}

/** Collect result from a synthetic cell's marker line, or null. */
export function parseGcCollectResult(stdout: string): GcCollectResult | null {
	const raw = parseMarkerLine<RawGcCollect>(stdout);
	if (!raw || raw.error !== undefined) return null;
	const collected = asNumber(raw.collected);
	const uncollectable = asNumber(raw.uncollectable);
	const before = parseRawPressure(raw.before);
	const after = parseRawPressure(raw.after);
	if (collected === undefined || uncollectable === undefined || !before || !after) return null;
	return { collected, uncollectable, before, after };
}

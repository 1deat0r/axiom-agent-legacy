/**
 * Live verification catalog: the four operator-gated live checks plus the
 * pure skip/probe/summarize logic that decides which checks can run.
 *
 * This module is dependency-free and side-effect-free: `plan` and
 * `summarize` are pure so the offline unit tests can encode the
 * "skip when keys are absent, never fail on a skip" contract.
 *
 * Runners live here too but only touch the network or the filesystem when
 * `run` is invoked with real credentials; the unit tests never call them.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROVIDER_KEY_ENV_VARS = ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"];
export const GATEWAY_TOKEN_ENV_VARS = ["AXIOM_TELEGRAM_BOT_TOKEN", "AXIOM_DISCORD_BOT_TOKEN", "AXIOM_SLACK_BOT_TOKEN"];
export const SOCKET_MODE_TOKEN_ENV_VARS = ["AXIOM_SLACK_APP_TOKEN"];
export const KERNEL_PYTHON_ENV_VAR = "AXIOM_KERNEL_PYTHON";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_JS = join(REPO_ROOT, "packages/coding-agent/dist/cli.js");
const KERNEL_MODULE = join(REPO_ROOT, "packages/coding-agent/dist/core/kernel/index.js");
const PROBE_PROMPT = "Reply with the single word: ok";

const PROVIDER_CHAT_TIMEOUT_MS = 30_000;
const AGENT_RUN_TIMEOUT_MS = 180_000;
const KERNEL_BOOT_TIMEOUT_MS = 60_000;
const GATEWAY_PROBE_TIMEOUT_MS = 20_000;

/** Chat-completion model used by the provider-chat check, overridable per provider. */
const CHAT_MODELS = {
	deepseek: (env) => env.LIVE_CHECK_DEEPSEEK_MODEL || "deepseek-chat",
	openai: (env) => env.LIVE_CHECK_OPENAI_MODEL || "gpt-4o-mini",
	anthropic: (env) => env.LIVE_CHECK_ANTHROPIC_MODEL || "claude-sonnet-4-6",
	gemini: (env) => env.LIVE_CHECK_GEMINI_MODEL || "gemini-2.5-flash",
};

/** Model the agent-run check passes to the CLI, resolved from the repo model registry. */
const AGENT_MODELS = {
	deepseek: (env) => env.LIVE_CHECK_AGENT_MODEL || "deepseek-v4-flash",
	openai: (env) => env.LIVE_CHECK_AGENT_MODEL || "gpt-4o-mini",
	anthropic: (env) => env.LIVE_CHECK_AGENT_MODEL || "claude-sonnet-4-6",
	gemini: (env) => env.LIVE_CHECK_AGENT_MODEL || "gemini-2.5-flash",
};

function present(env, name) {
	return typeof env[name] === "string" && env[name].length > 0;
}

function firstPresent(env, names) {
	return names.find((name) => present(env, name));
}

function truncate(text, max) {
	if (typeof text !== "string") return "";
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/**
 * Candidate kernel pythons, mirroring the repo bootstrap: an explicit
 * AXIOM_KERNEL_PYTHON wins; otherwise the kernel venv (AXIOM_KERNEL_VENV
 * override or ~/.axiom/agent/kernel-venv) is the only candidate.
 */
export function resolveKernelPython(env, spawnImpl = spawnSync) {
	const explicit = env[KERNEL_PYTHON_ENV_VAR];
	if (explicit) {
		const check = spawnImpl(explicit, ["-c", "import ipykernel"], { encoding: "utf8" });
		return check.status === 0 ? explicit : null;
	}
	const venv = env.AXIOM_KERNEL_VENV || join(homedir(), ".axiom", "agent", "kernel-venv");
	const python = join(venv, "bin", "python");
	if (!existsSync(python)) return null;
	const check = spawnImpl(python, ["-c", "import ipykernel"], { encoding: "utf8" });
	return check.status === 0 ? python : null;
}

/** One probe against a provider's REST chat endpoint; never throws. */
async function chatOnce(provider, key, model, prompt, timeoutMs) {
	const request = {
		deepseek: {
			url: "https://api.deepseek.com/chat/completions",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: { model, messages: [{ role: "user", content: prompt }], max_tokens: 16, stream: false },
			extract: (json) => json?.choices?.[0]?.message?.content,
		},
		openai: {
			url: "https://api.openai.com/v1/chat/completions",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: { model, messages: [{ role: "user", content: prompt }], max_tokens: 16, stream: false },
			extract: (json) => json?.choices?.[0]?.message?.content,
		},
		anthropic: {
			url: "https://api.anthropic.com/v1/messages",
			headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
			body: { model, max_tokens: 16, messages: [{ role: "user", content: prompt }] },
			extract: (json) => json?.content?.map((block) => block.text ?? "").join(""),
		},
		gemini: {
			url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
			headers: { "Content-Type": "application/json" },
			body: { contents: [{ parts: [{ text: prompt }] }] },
			extract: (json) => json?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join(""),
		},
	}[provider];

	if (!request) return { ok: false, detail: `no chat probe for provider ${provider}` };
	try {
		const response = await fetch(request.url, {
			method: "POST",
			headers: request.headers,
			body: JSON.stringify(request.body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const raw = await response.text();
		if (!response.ok) return { ok: false, detail: `HTTP ${response.status}: ${truncate(raw, 200)}` };
		let json = {};
		try {
			json = JSON.parse(raw);
		} catch {
			return { ok: false, detail: `non-JSON response: ${truncate(raw, 200)}` };
		}
		const text = request.extract(json) ?? "";
		if (!text.trim()) return { ok: false, detail: "completion returned no text" };
		return { ok: true, detail: `reply via ${provider} (${model}): ${truncate(text, 80)}` };
	} catch (error) {
		return { ok: false, detail: `request failed: ${truncate(String(error?.message ?? error), 200)}` };
	}
}

async function runProviderChat(ctx) {
	const provider = firstPresent(ctx.env, PROVIDER_KEY_ENV_VARS);
	if (!provider) return { ok: false, detail: "no provider key present (plan should have skipped this check)" };
	return chatOnce(provider, ctx.env[provider], CHAT_MODELS[provider](ctx.env), PROBE_PROMPT, PROVIDER_CHAT_TIMEOUT_MS);
}

/** Scrub RLM harness vars that make spawned axiom children hang (delegate-tool lesson). */
function childEnvFor(env) {
	const childEnv = { ...env };
	for (const key of Object.keys(childEnv)) {
		if (key.startsWith("RLM_")) delete childEnv[key];
	}
	delete childEnv.AXIOM_PROJECT_ROOT;
	return childEnv;
}

function runAgentRun(ctx) {
	return new Promise((resolvePromise) => {
		const provider = firstPresent(ctx.env, PROVIDER_KEY_ENV_VARS);
		if (!provider) {
			resolvePromise({ ok: false, detail: "no provider key present (plan should have skipped this check)" });
			return;
		}
		const args = [
			CLI_JS,
			"--mode",
			"json",
			"--provider",
			provider,
			"--model",
			AGENT_MODELS[provider](ctx.env),
			PROBE_PROMPT,
		];
		const child = spawn(process.execPath, args, {
			cwd: REPO_ROOT,
			env: { ...childEnvFor(ctx.env), AXIOM_HOME: join(tmpdir(), `axiom-live-check-${Date.now()}`) },
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			resolvePromise({ ok: false, detail: `timed out after ${AGENT_RUN_TIMEOUT_MS / 1000}s` });
		}, AGENT_RUN_TIMEOUT_MS);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise({ ok: false, detail: `spawn failed: ${truncate(String(error?.message ?? error), 200)}` });
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0 && stdout.trim().length > 0) {
				resolvePromise({ ok: true, detail: `exit 0, reply: ${truncate(stdout, 120)}` });
				return;
			}
			const tail = truncate(stderr || stdout, 200);
			resolvePromise({ ok: false, detail: `exit ${code}: ${tail}` });
		});
	});
}

async function runRlmKernel(ctx) {
	const python = ctx.deps.resolveKernelPython(ctx.env);
	if (!python) return { ok: false, detail: "no kernel python (plan should have skipped this check)" };
	let manager;
	try {
		const moduleUrl = pathToFileURL(KERNEL_MODULE).href;
		const { KernelManager } = await import(moduleUrl);
		manager = new KernelManager({ python, cwd: REPO_ROOT });
		await withTimeout(manager.start(), KERNEL_BOOT_TIMEOUT_MS, "kernel start");
		const result = await manager.execute("print(1+1)");
		if (result.status === "ok" && result.stdout.includes("2")) {
			return { ok: true, detail: `print(1+1) -> "2" via ${python}` };
		}
		return {
			ok: false,
			detail: `status=${result.status} stdout=${truncate(result.stdout, 120)} stderr=${truncate(result.stderr, 120)}`,
		};
	} catch (error) {
		return { ok: false, detail: `kernel boot failed: ${truncate(String(error?.message ?? error), 200)}` };
	} finally {
		if (manager) await manager.dispose().catch(() => {});
	}
}

async function withTimeout(promise, ms, label) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** One transport auth probe; proves the token is live and the surface reachable. */
async function probeTransport(name, url, headers, body, extract, timeoutMs) {
	try {
		const response = await fetch(url, {
			method: body ? "POST" : "GET",
			headers,
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(timeoutMs),
		});
		const raw = await response.text();
		let json = {};
		try {
			json = JSON.parse(raw);
		} catch {
			// keep raw text for the failure detail
		}
		const detail = extract(json, response.status, raw);
		if (response.ok && detail.ok) return { ok: true, detail: `${name}: ${detail.text}` };
		return { ok: false, detail: `${name}: ${detail.text}` };
	} catch (error) {
		return { ok: false, detail: `${name}: request failed: ${truncate(String(error?.message ?? error), 200)}` };
	}
}

async function runGatewayDelivery(ctx) {
	const probes = [];
	if (present(ctx.env, "AXIOM_TELEGRAM_BOT_TOKEN")) {
		probes.push(
			probeTransport(
				"telegram",
				`https://api.telegram.org/bot${ctx.env.AXIOM_TELEGRAM_BOT_TOKEN}/getMe`,
				{},
				null,
				(json, status, raw) =>
					json?.ok === true
						? { ok: true, text: `getMe ok:true for @${json.result?.username ?? "unknown"}` }
						: { ok: false, text: `getMe ok:false (HTTP ${status}): ${truncate(raw, 160)}` },
				GATEWAY_PROBE_TIMEOUT_MS,
			),
		);
	}
	if (present(ctx.env, "AXIOM_DISCORD_BOT_TOKEN")) {
		probes.push(
			probeTransport(
				"discord",
				"https://discord.com/api/v10/users/@me",
				{ Authorization: `Bot ${ctx.env.AXIOM_DISCORD_BOT_TOKEN}` },
				null,
				(json, status, raw) =>
					json?.id
						? { ok: true, text: `users/@me ok for bot ${json.username ?? json.id}` }
						: { ok: false, text: `users/@me rejected (HTTP ${status}): ${truncate(raw, 160)}` },
				GATEWAY_PROBE_TIMEOUT_MS,
			),
		);
	}
	if (present(ctx.env, "AXIOM_SLACK_BOT_TOKEN")) {
		probes.push(
			probeTransport(
				"slack",
				"https://slack.com/api/auth.test",
				{ Authorization: `Bearer ${ctx.env.AXIOM_SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
				{},
				(json, status, raw) =>
					json?.ok === true
						? { ok: true, text: `auth.test ok:true for ${json.user ?? json.team ?? "bot"}` }
						: { ok: false, text: `auth.test ok:false (HTTP ${status}): ${truncate(raw, 160)}` },
				GATEWAY_PROBE_TIMEOUT_MS,
			),
		);
	}
	const results = await Promise.all(probes);
	const failed = results.filter((result) => !result.ok);
	if (failed.length > 0) return { ok: false, detail: failed.map((result) => result.detail).join("; ") };
	if (results.length === 0) return { ok: false, detail: "no transport token present (plan should have skipped this check)" };
	return { ok: true, detail: results.map((result) => result.detail).join("; ") };
}

/**
 * One probe against the Socket Mode surface (ADR-0062): apps.connections.open
 * proves the app token is live and returns the websocket url. The REST-only
 * gateway-delivery check never touches this surface. Never throws.
 */
async function runSlackSocketSurface(ctx) {
	if (!present(ctx.env, "AXIOM_SLACK_APP_TOKEN")) {
		return { ok: false, detail: "no socket-mode app token present (plan should have skipped this check)" };
	}
	return probeTransport(
		"slack socket mode",
		"https://slack.com/api/apps.connections.open",
		{ Authorization: `Bearer ${ctx.env.AXIOM_SLACK_APP_TOKEN}`, "Content-Type": "application/json" },
		{},
		(json, status, raw) =>
			json?.ok === true && typeof json?.url === "string" && json.url.length > 0
				? { ok: true, text: "apps.connections.open ok:true with a websocket url" }
				: { ok: false, text: `apps.connections.open ok:false (HTTP ${status}): ${truncate(raw, 160)}` },
		GATEWAY_PROBE_TIMEOUT_MS,
	);
}

/**
 * The catalog. Each check names what it proves, which env vars it needs,
 * and what its output looks like when it passes.
 */
export const CHECKS = [
	{
		id: "provider-chat",
		name: "Provider chat round-trip",
		purpose:
			"Proves one configured provider key completes a real chat completion over the network, so model access and the key itself are live.",
		envVars: { anyOf: PROVIDER_KEY_ENV_VARS },
		expectedOutput:
			"An assistant message with non-empty text; the probe asks for the single word 'ok'. Override the model per provider with LIVE_CHECK_DEEPSEEK_MODEL / LIVE_CHECK_OPENAI_MODEL / LIVE_CHECK_ANTHROPIC_MODEL / LIVE_CHECK_GEMINI_MODEL.",
		run: runProviderChat,
	},
	{
		id: "agent-run",
		name: "Agent run end to end",
		purpose:
			"Proves the full agent loop boots and answers through the real CLI: provider, model registry, session, and completion pipeline in one run.",
		envVars: { anyOf: PROVIDER_KEY_ENV_VARS },
		extraRequirements: [
			{
				label: `built CLI at ${CLI_JS} (run: npm run build)`,
				satisfied: (_env, deps) => deps.cliJsExists(CLI_JS),
			},
		],
		expectedOutput:
			"Exit code 0 with the assistant's reply on stdout (the probe asks for the single word 'ok'). Override the model with LIVE_CHECK_AGENT_MODEL.",
		run: runAgentRun,
	},
	{
		id: "rlm-kernel",
		name: "RLM kernel boot",
		purpose:
			"Proves the IPython kernel the RLM prompt relies on boots and executes a cell, using the repo's own KernelManager.",
		envVars: undefined,
		extraRequirements: [
			{
				label: "a kernel python (AXIOM_KERNEL_PYTHON, AXIOM_KERNEL_VENV, or ~/.axiom/agent/kernel-venv with ipykernel)",
				satisfied: (env, deps) => deps.resolveKernelPython(env) !== null,
			},
			{
				label: `built kernel module at ${KERNEL_MODULE} (run: npm run build)`,
				satisfied: (_env, deps) => deps.kernelModuleExists(KERNEL_MODULE),
			},
		],
		expectedOutput: 'The cell "print(1+1)" reports status ok and stdout contains "2".',
		run: runRlmKernel,
	},
	{
		id: "gateway-delivery",
		name: "Gateway delivery surface",
		purpose:
			"Proves each configured transport token is live and its API surface reachable (Telegram getMe, Discord users/@me, Slack auth.test). A full message round-trip through the booted gateway is the operator's manual pass (docs/live-verification.md).",
		envVars: { anyOf: GATEWAY_TOKEN_ENV_VARS },
		expectedOutput:
			"Telegram: getMe ok:true with the bot username. Discord: users/@me returns the bot id. Slack: auth.test ok:true. Every configured token must pass.",
		run: runGatewayDelivery,
	},
	{
		id: "slack-socket-mode",
		name: "Slack Socket Mode surface",
		purpose:
			"Proves the Socket Mode app token is live and the websocket surface reachable (apps.connections.open returns a socket url). The REST-only gateway-delivery check never touches this surface, which is the gap ADR-0062's opt-in opened. A full socket receive round-trip stays the operator's manual pass (docs/live-verification.md).",
		envVars: { anyOf: SOCKET_MODE_TOKEN_ENV_VARS },
		expectedOutput:
			"Slack apps.connections.open ok:true with a websocket url. The full socket receive loop stays the operator's manual pass (docs/live-verification.md).",
		run: runSlackSocketSurface,
	},
];

/**
 * The requirements a check is missing. Empty = the check can run.
 * Pure: only reads `env` and calls the injected deps.
 */
export function missingRequirements(check, env, deps) {
	const missing = [];
	const envVars = check.envVars;
	if (envVars) {
		if (Array.isArray(envVars)) {
			for (const name of envVars) {
				if (!present(env, name)) missing.push(name);
			}
		} else if (envVars.anyOf) {
			if (!envVars.anyOf.some((name) => present(env, name))) {
				missing.push(`one of: ${envVars.anyOf.join(", ")}`);
			}
		}
	}
	for (const extra of check.extraRequirements ?? []) {
		if (!extra.satisfied(env, deps)) missing.push(extra.label);
	}
	return missing;
}

/**
 * Split the catalog into runnable and skipped checks. Pure.
 * Skipped checks carry the reasons, so a SKIP line is always honest.
 */
export function plan(checks, env, deps) {
	const runnable = [];
	const skipped = [];
	for (const check of checks) {
		const reasons = missingRequirements(check, env, deps);
		if (reasons.length === 0) runnable.push(check);
		else skipped.push({ check, reasons });
	}
	return { runnable, skipped };
}

/**
 * Turn check results into report lines and the exit decision. Pure.
 * Exit code 1 only when a check that RAN failed; skips never fail.
 */
export function summarize(results) {
	let ran = 0;
	let skipped = 0;
	let passed = 0;
	let failed = 0;
	const lines = [];
	for (const { check, outcome, detail, reasons } of results) {
		if (outcome === "skip") {
			skipped += 1;
			const reasonText = (reasons ?? []).join("; ");
			lines.push(`SKIP ${check.id} — ${reasonText}`);
		} else {
			ran += 1;
			if (outcome === "pass") {
				passed += 1;
				lines.push(`PASS ${check.id} — ${detail}`);
			} else {
				failed += 1;
				lines.push(`FAIL ${check.id} — ${detail}`);
			}
		}
	}
	return { lines, ran, skipped, passed, failed, exitCode: failed > 0 ? 1 : 0 };
}

/** Default deps for real runs: the filesystem and the real kernel python probe. */
export function makeDefaultDeps() {
	return {
		cliJsExists: (path) => existsSync(path),
		kernelModuleExists: (path) => existsSync(path),
		resolveKernelPython: (env) => resolveKernelPython(env),
	};
}

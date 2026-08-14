#!/usr/bin/env node
/**
 * Live verification harness: run the operator-gated live checks.
 *
 * Usage:
 *   node tools/live-verification/run.mjs            run every check that can run
 *   node tools/live-verification/run.mjs --list     print the catalog
 *   node tools/live-verification/run.mjs --check <id>   run one check
 *   node tools/live-verification/run.mjs --json     machine-readable report on stdout
 *
 * Exit codes: 0 = every check that ran passed (all-SKIP is 0, never a
 * failure); 1 = at least one check that ran failed; 2 = usage error.
 *
 * Keys are operator-owned. This script only ever reads them from the
 * environment; it never logs a key value.
 */
import { CHECKS, makeDefaultDeps, plan, summarize } from "./catalog.mjs";

function usageError(message) {
	process.stderr.write(`run.mjs: ${message}\n`);
	process.stderr.write("usage: node tools/live-verification/run.mjs [--list] [--check <id>] [--json]\n");
	process.exitCode = 2;
	return null;
}

function parseArgs(argv) {
	const args = { list: false, check: undefined, json: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--list") args.list = true;
		else if (arg === "--json") args.json = true;
		else if (arg === "--check") {
			if (i + 1 >= argv.length) return usageError("--check needs a check id");
			args.check = argv[++i];
		} else return usageError(`unknown argument ${arg}`);
	}
	return args;
}

function renderCatalog(checks) {
	const lines = [];
	for (const check of checks) {
		lines.push(`${check.id} — ${check.name}`);
		lines.push(`  proves: ${check.purpose}`);
		if (check.envVars) {
			const envVars = Array.isArray(check.envVars) ? check.envVars.join(", ") : `one of: ${check.envVars.anyOf.join(", ")}`;
			lines.push(`  env: ${envVars}`);
		}
		for (const extra of check.extraRequirements ?? []) {
			lines.push(`  needs: ${extra.label}`);
		}
		lines.push(`  expects: ${check.expectedOutput}`);
	}
	return lines.join("\n");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args) return;

	if (args.list) {
		process.stdout.write(`${renderCatalog(CHECKS)}\n`);
		return;
	}

	let checks = CHECKS;
	if (args.check) {
		checks = CHECKS.filter((check) => check.id === args.check);
		if (checks.length === 0) {
			process.stderr.write(`run.mjs: unknown check id "${args.check}" (known: ${CHECKS.map((c) => c.id).join(", ")})\n`);
			process.exitCode = 2;
			return;
		}
	}

	const deps = makeDefaultDeps();
	const { runnable, skipped } = plan(checks, process.env, deps);

	const log = (message) => {
		if (!args.json) process.stdout.write(`${message}\n`);
		else process.stderr.write(`${message}\n`);
	};

	log(`live verification: ${runnable.length} check(s) can run, ${skipped.length} skipped`);

	const results = skipped.map(({ check, reasons }) => ({
		check,
		outcome: "skip",
		detail: reasons.join("; "),
		reasons,
	}));

	for (const check of runnable) {
		log(`running ${check.id}...`);
		const startedAt = Date.now();
		let result;
		try {
			result = await check.run({ env: process.env, repoRoot: process.cwd(), log, deps });
		} catch (error) {
			result = { ok: false, detail: `unexpected error: ${String(error?.message ?? error).slice(0, 200)}` };
		}
		const durationMs = Date.now() - startedAt;
		results.push({
			check,
			outcome: result.ok ? "pass" : "fail",
			detail: `${result.detail} (${(durationMs / 1000).toFixed(1)}s)`,
		});
	}

	const summary = summarize(results);
	if (args.json) {
		process.stdout.write(
			`${JSON.stringify({
				ran: summary.ran,
				skipped: summary.skipped,
				passed: summary.passed,
				failed: summary.failed,
				exitCode: summary.exitCode,
				results: results.map((entry) => ({
					id: entry.check.id,
					name: entry.check.name,
					outcome: entry.outcome,
					detail: entry.detail,
					reasons: entry.reasons,
				})),
			})}\n`,
		);
	} else {
		process.stdout.write(`${summary.lines.join("\n")}\n`);
	}
	process.exitCode = summary.exitCode;
}

await main();

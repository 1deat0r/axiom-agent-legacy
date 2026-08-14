# Live verification — run recipe

Operator-gated live checks: a catalog of four checks that run only when their
keys are present, and skip (never fail) when they are not.

## Quick start

```sh
npm run build                              # agent-run and rlm-kernel load dist
node tools/live-verification/run.mjs --list     # the catalog
DEEPSEEK_API_KEY=... node tools/live-verification/run.mjs            # run what can run
DEEPSEEK_API_KEY=... node tools/live-verification/run.mjs --check agent-run --json
```

## Exit codes

- 0 — every check that ran passed, or nothing could run (all-SKIP is 0).
- 1 — at least one check that ran failed.
- 2 — usage error.

Missing keys can never fail a run; the SKIP line names what was missing.

## Env requirements per check

- `provider-chat`, `agent-run`: one of `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`. `agent-run` also needs the built CLI
  (`packages/coding-agent/dist/cli.js`). Model overrides:
  `LIVE_CHECK_AGENT_MODEL` (agent-run), `LIVE_CHECK_<PROVIDER>_MODEL`
  (provider-chat).
- `rlm-kernel`: `AXIOM_KERNEL_PYTHON`, or `AXIOM_KERNEL_VENV` /
  `~/.axiom/agent/kernel-venv` containing a python with `ipykernel`; plus the
  built kernel module (`packages/coding-agent/dist/core/kernel/index.js`).
- `gateway-delivery`: one or more of `AXIOM_TELEGRAM_BOT_TOKEN`,
  `AXIOM_DISCORD_BOT_TOKEN`, `AXIOM_SLACK_BOT_TOKEN`. Every token present is
  probed and every probe must pass.

Keys are read only from the environment; the script never logs a key value.

## CI

Workflow `.github/workflows/live-verification.yml`: `workflow_dispatch`, or
comment `/run-live` on a PR. Repository secrets map one-to-one onto the env
names above. All-SKIP runs stay silent (no PR comment). The full operator
ledger with one checkbox per deferred ADR follow-up lives in
`docs/live-verification.md`.

## What this is not

No live run happened in the sandbox and the harness does not boot the
gateway or send messages. The full message round-trip through a booted
gateway is the operator's manual pass (checkboxes in
`docs/live-verification.md`); the harness proves keys and surfaces.

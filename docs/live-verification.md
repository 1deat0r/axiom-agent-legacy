# Live verification — operator handbook

The live passes this repo keeps deferring to the operator now have a home:
`tools/live-verification/run.mjs` (catalog + runner) and
`.github/workflows/live-verification.yml` (on-demand CI trigger). This page is
the ledger: what each check proves, how to run it, and one checkbox per ADR
follow-up that still waits on the operator.

## The checks

| Check | Proves | Needs | Expected output |
| --- | --- | --- | --- |
| `provider-chat` | One configured provider key completes a real chat completion over the network. | One of `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | An assistant reply with non-empty text (the probe asks for "ok"). |
| `agent-run` | The full agent loop boots and answers through the real CLI: provider, model registry, session, completion. | A provider key + built CLI (`npm run build`) | Exit 0 with the assistant's reply on stdout. |
| `rlm-kernel` | The IPython kernel the RLM prompt relies on boots and executes a cell (via the repo's own `KernelManager`). | `AXIOM_KERNEL_PYTHON` or the kernel venv (`AXIOM_KERNEL_VENV` / `~/.axiom/agent/kernel-venv`) + built kernel module | `print(1+1)` reports status ok and stdout contains "2". |
| `gateway-delivery` | Each configured transport token is live and its API surface reachable. | One or more of `AXIOM_TELEGRAM_BOT_TOKEN`, `AXIOM_DISCORD_BOT_TOKEN`, `AXIOM_SLACK_BOT_TOKEN` | Telegram `getMe` ok:true with the bot username; Discord `users/@me` returns the bot id; Slack `auth.test` ok:true. |
| `slack-socket-mode` | The Socket Mode app token is live and the websocket surface reachable (the REST-only `gateway-delivery` check never touches it). | `AXIOM_SLACK_APP_TOKEN` | Slack `apps.connections.open` ok:true with a websocket url. |
| `cron-spine` | The real gateway cron spine claims, runs, delivers, and ledger-records a scheduled run on the compiled binary (stubbed completion — no spend, no tokens), and a due heartbeat sharing the same store file survives the sweep untouched (the shared-store claim race). | Built gateway cron module (`npm run build`) — runs whenever the build exists, even with no keys | One once-job completes (runCount 1), its reply delivers to its channel, one ok:true ledger entry is recorded, and the shared heartbeat is untouched. |

`node tools/live-verification/run.mjs --list` prints the full catalog with
purposes and requirements. `--json` emits a machine-readable report. Model
overrides: `LIVE_CHECK_AGENT_MODEL` (agent-run), and per provider
`LIVE_CHECK_DEEPSEEK_MODEL`, `LIVE_CHECK_OPENAI_MODEL`,
`LIVE_CHECK_ANTHROPIC_MODEL`, `LIVE_CHECK_GEMINI_MODEL` (provider-chat).

## Exit contract

A check whose requirements are absent is SKIPped with the reason named.
All-SKIP is exit 0 — missing keys can never fail a run. Exit 1 means exactly
"a check that ran failed". Keys are only read from the environment; the script
never logs a key value.

## Running it

Locally, with keys in the environment:

```sh
npm run build          # agent-run and rlm-kernel load dist
DEEPSEEK_API_KEY=... AXIOM_TELEGRAM_BOT_TOKEN=... node tools/live-verification/run.mjs
```

In CI: comment `/run-live` on a PR (only on PRs; the report comment posts back
on that PR), or trigger the workflow manually from the Actions tab. The
workflow maps repository secrets one-to-one onto the env names above. When no
secrets are set, the run is silent (no comment) and green.

## Operator follow-up ledger

Every ADR follow-up that defers a live pass to the operator. One checkbox per
item; tick it and link the run's report (or paste the SKIP reason) when done.

### Deferred live passes (literal "operator follow-up" phrasing)

- [ ] **ADR-0017 (Telegram gateway)** — "the live pass is the operator
  follow-up." Create the bot with @BotFather, set `AXIOM_TELEGRAM_BOT_TOKEN`,
  allowlist the personal chat id, point the completion runner at a working
  provider. Then run `gateway-delivery` plus one manual round-trip message.
- [ ] **ADR-0020 (Discord gateway)** — "the live pass is the operator
  follow-up." Create the bot in the Dev Portal, enable the messages intent,
  set `AXIOM_DISCORD_BOT_TOKEN`, allowlist the user id, point the completion
  runner at a working provider. Then run `gateway-delivery` plus one manual
  round-trip message.
- [ ] **ADR-0021 (Slack gateway)** — "the live pass is the operator
  follow-up" (recorded twice: "the live pass is token-gated and stays an
  operator follow-up"). Create the Slack app with a bot token, add it to the
  channels, set `AXIOM_SLACK_BOT_TOKEN`, allowlist the user id, point the
  completion runner at a working provider. Then run `gateway-delivery` plus
  one manual round-trip message.

### Deferred live passes (equivalent phrasings)

- [ ] **ADR-0062 (Slack Socket Mode)** — "Live Socket Mode and live
  cross-platform fan-out remain operator follow-ups (no Slack/Discord
  credentials in this sandbox); the gateway is exercised by its test suite
  until then." Set `AXIOM_SLACK_APP_TOKEN` (and `SLACK_SOCKET_MODE`) and run
  `slack-socket-mode`; then send one manual message through the booted
  socket-mode gateway to confirm the receive loop.
- [ ] **ADR-0016 (Signal gateway)** — "the gateway is exercised by its test
  suite and the live pass is the follow-up." Link signal-cli, add the number
  to the allowlist, point the completion runner at a working provider. Then
  send one manual message through the booted gateway.
- [ ] **ADR-0023 (cross-transport fan-out)** — "live cross-platform
  verification is operator-gated (needs tokens for more than one platform)."
  Set at least two of the three transport tokens and run `gateway-delivery`;
  then fan one message out to every configured platform and check the ledger
  records one entry per transport.
- [ ] **ADR-0029 (delegate tool)** — "Live cross-provider validation is an
  operator-gated follow-up." Set keys for at least two providers and run
  `provider-chat` for each, then one `agent-run` per provider (override the
  model with `LIVE_CHECK_AGENT_MODEL` where the registry default is not the
  model you run).
- [ ] **ADR-0052 (root guard)** — "No live model/provider verification in
  this sandbox — verification is unit plus mock, recorded as such." Run
  `provider-chat` and `agent-run` once with a real provider on an anchored
  run to confirm the guarded tool paths behave the same live as they do
  under mock.

## What the harness does not do

The harness proves tokens and keys are live and the surfaces reachable. It
does not boot the gateway, does not send a message through it, and does not
manage CI secrets. Those stay operator actions, and the round-trip remains
the manual pass named in each checkbox above.

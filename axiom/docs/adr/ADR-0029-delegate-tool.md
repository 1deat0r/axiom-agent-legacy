# ADR-0029 — Delegate tool: RPC bridge with a compact result block

- Status: accepted
- Date: 2026-08-12
- Branch: feat/delegate-rpc
- Related: ADR-0015 (prime-agent baseline), ADR-0010 (cost ledger), feature #5 (Delegate + script-as-tool RPC)

## Context

Axiom has RLM subagents (async, fire-and-forget; results via agent_message/files). The Hermes
trick feature #5 wants the complementary synchronous collapse: a plain agent turn that delegates
a multi-step job to an isolated helper and receives back only a compact result — the parent never
sees the helper's intermediate tool calls or full context, so a pipeline costs one turn and zero
added parent context.

The baseline already ships a process-spawning RPC bridge (`--mode rpc` + `RpcClient`): a headless
agent read on stdin, streaming events on stdout. That is the least-new-surface, most-literal
"helper process" primitive.

## Decision

Add an axiom `delegate` tool (a new extension in `src/extensions/delegate/`, registered in
`builtInExtensions`). Calling it:
- builds one fresh helper process via the existing RPC bridge (`createRpcClientBridge` wrapping
  `RpcClient`), optionally configured with a `provider/model` via `parseModelRef`;
- runs one bounded task (`promptAndWait` with a budget clamped to MAX_TIMEOUT_MS, guarded for
  non-finite input);
- harvests the helper's closing text (`getLastAssistantText`) + recorded `SessionStats` tokens/cost;
- returns ONLY a compact block `{ok, summary, tokens, cost, helper?, error?}` to the parent, where
  `summary` is length-capped (no transcript) and `tokens`/`cost` are recorded, never guessed
  (ADR-0010 ethos);
- always `stop()`s the helper in `finally` so a timeout/error never orphans the process.

The bridge is an injected narrow interface so neutral tests drive the tool with a deterministic
stub (no process, no keys) while the genuine helper process path is covered by a live-gated test.

## Consequences

Parent context gains only the compact block; intermediate calls stay in the isolated helper.
Per-call fresh process = no cross-call state and no orphan on failure. The helper shares the
parent's provider credentials via inherited env; the first step does not propagate the parent's
live in-memory model selection (a recorded follow-up). Live cross-provider validation is an
operator-gated follow-up.

## Follow-ups (honest)

- Propagate the parent's active provider/model selection instead of only an explicit `model` param.
- Expose `helper.sessionId` / files written by the helper in the block.
- Batch/parallel delegation (Hermes `async_delegation`) as a later step.

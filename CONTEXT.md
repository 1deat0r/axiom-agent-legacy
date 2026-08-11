# Axiom

An agent framework forked from **prime-agent v0.7.2** (MIT, PrimeIntellect-ai;
the successor to earendil-works/pi by the same author) and grown past it: the
prime baseline (agent core, multi-provider AI layer, TUI, extensions, daemon,
RLM, subagents) plus the capabilities it does not have — cost ledger, spend
cap, memory tool, profiles — ported from the pi fork (ADR-0015).

## Language

**Baseline**:
Prime-agent v0.7.2, the upstream tree this repo forks; `baseline/prime-v0.7.2`
is the fork branch, upstream `main` merges routinely (remote `upstream`).
_Avoid_: Vendor, the old pi line (the pi fork lives on `archive/pi-v0.84.1`,
remote `upstream-pi`; it is seed corn and reference, not the working trunk)

**Port**:
The act of re-implementing an archived axiom capability on the baseline
(ADR-0015), red-first, one tracker issue per port (`docs/ports.md`).
_Avoid_: Migration, rewrite

**Axiom home**:
The directory holding axiom-owned durable state (ledger config, memory store,
profiles): `AXIOM_HOME`, default `~/.axiom`. Baseline-independent by design —
it survives a baseline change (ADR-0015, data-cutover rule).
_Avoid_: Config dir, home dir

**Profile**:
A named agent identity (Hermes model): its own home holding SOUL.md, agent
state (sessions/skills/settings via the active agent dir), and axiom state.
`--profile <name>` boots the process there. Process-level isolation — never
two agent processes on one profile home.
_Avoid_: Persona, account

**Channel**:
A conversation's stable address on a messaging platform (gateway port,
ADR-0001 — deferred until the gateway is re-ported).
_Avoid_: Thread, room, conversation id

**Session**:
A single agent conversation: its system prompt, message history, and any
memory or skills context loaded for it. One channel maps to one session.
_Avoid_: Thread, chat

**Cost ledger**:
The pricing side of the agent: token usage priced per model (override rates
from the axiom ledger file, else the cost the baseline recorded), accumulated
per run and per session, shown by `/cost`. Never invents spend — it prices
only recorded tokens (ADR-0010).
_Avoid_: Billing, usage dashboard

**Spend cap**:
A configured USD ceiling for one run (`maxRunCostUsd`); the loop stops before
the next LLM call once the run's recorded spend reaches it (ADR-0011). The
baseline's `/goal` token budget is a token ceiling, not this.
_Avoid_: Budget, cost limit (the wire constant `finishReason: 'cost_limit'` is
an API string, not a drift)

**Memory tool**:
The axiom `memory` tool (add/remove/list durable facts, user or agent scope)
with per-scope LRU eviction (ADR-0008). Distinct from the baseline's
session-backed refinement/harness state, which is agent learning, not a
user-facing durable memory.
_Avoid_: Memory (the baseline's refinement), skills

**Thinking effort**:
The persisted quality-cost knob of the active provider; the baseline has
per-model thinking levels — the axiom knob maps the low/medium/high levels
onto them.
_Avoid_: Reasoning level, intelligence slider

**Drift**:
An agent acting outside its project's identity, context, or boundary — wrong
files, wrong memory, wrong ledger. Prevented by the anti-drift ladder
(identity → context → root guard → process), never by prompting alone.
_Avoid_: Confusion, contamination (contamination is the mechanism, not the
category)

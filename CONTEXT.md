# Axiom

An agent framework forked from pi v0.84.1 (MIT, earendil-works) and grown past
it: the pi baseline (agent core, multi-provider AI layer, TUI, extensions)
plus the capabilities pi does not have — cost ledger, spend cap, provider
catalog + wizard, gateway, memory eviction — ported from the archived
from-scratch tree (ADR-0013).

## Language

**Baseline**:
Pi v0.84.1, the upstream tree this repo forks; `baseline/pi-v0.84.1` is the
fork branch, upstream `main` merges routinely.
_Avoid_: Vendor, upstream code (upstream is fine for the remote)

**Port**:
The act of re-implementing an archived axiom capability on the baseline,
red-first, one tracker issue per port (`docs/ports.md`).
_Avoid_: Migration, rewrite

**Channel**:
A conversation's stable address on a messaging platform (gateway port, ADR-0001).
_Avoid_: Thread, room, conversation id

**Session**:
A single agent conversation: its system prompt, message history, and any memory or skills context loaded for it. One channel maps to one session.
_Avoid_: Thread, chat

**Transport**:
The connector that adapts one platform's raw events to and from Axiom's normalized message shape (gateway port).
_Avoid_: Adapter, bridge, connector

**Command**:
A directive from a user that the gateway handles itself rather than passing to the agent.
_Avoid_: Slash command, meta-message

**Provider**:
A named LLM endpoint entry in the catalog (openai, claude, z-ai, …): its official base URL, a default model id, and the env var that holds its key. The active provider is what the agent loop talks to.
_Avoid_: Backend, model, API

**Catalog**:
The built-in list of provider entries; `providers.json` entries add to or override it by name.
_Avoid_: Provider list, defaults

**Cost ledger**:
The pricing side of the agent: token usage priced per model (catalog table, entry override, or default rate), accumulated per run and per session, shown by `/cost`. Pi's model catalog carries per-model cost metadata; the ported ledger reads from it.
_Avoid_: Billing, usage dashboard

**Spend cap**:
A configured USD ceiling for one run (`maxRunCostUsd`); the loop stops before the next LLM call once the run's recorded spend reaches it.
_Avoid_: Budget, cost limit
(Note: the wire constant is `finishReason: 'cost_limit'` — an API string, not a drift to the avoided word.)

**Thinking effort**:
The persisted quality-cost knob of the active provider; pi has per-model thinking levels — the axiom port maps the low/medium/high knob onto them.
_Avoid_: Reasoning level, intelligence slider

**Profile**:
A named agent identity (Hermes model): its own home directory holding SOUL.md, config, keys, memory, skills, and sessions. Process-level isolation — never two agent processes on one profile home.
_Avoid_: Persona, account

**Project**:
A named workspace inside a profile: binds a root directory and owns scoped sessions, memory, ledger, cap, and sandbox rules. The active project's identity rides the system prompt.
_Avoid_: Workspace, folder, repo

**Root guard**:
The tool-layer enforcement that blocks resolved paths outside the project root, or routes an escape to an explicit plain-English approval. The load-bearing rung of the anti-drift ladder.
_Avoid_: Sandbox (reserved for the OS-level strict tier)

**Drift**:
An agent acting outside its project's identity, context, or boundary — wrong files, wrong memory, wrong ledger. Prevented by the anti-drift ladder (identity → context → root guard → process), never by prompting alone.
_Avoid_: Confusion, contamination (contamination is the mechanism, not the category)

**Surface**:
A consumer of the agent core — pi's TUI, the CLI, or the gateway. Surfaces attach to the core by subscribing to its events.
_Avoid_: Frontend, shell, interface

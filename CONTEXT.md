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

**Project**:
A named workspace inside a profile (<AXIOM_HOME>/profiles/<profile> or the
root home, under `projects/<name>`): a root directory that owns a run's
working tree. Booting the gateway with `--project <name>` anchors the run
there (cwd + AXIOM_PROJECT_ROOT) so the root guard (rung 3) confines edits.
_Avoid_: Folder, repo, task
**Channel**:
A conversation's stable address on a messaging platform (gateway, ADR-0001;
signal gateway shipped ADR-0016).
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

**Root guard**:
The ADR-0014 rung-3 enforcement: an axiom extension, inert unless a run is
anchored by AXIOM_PROJECT_ROOT, that blocks an `edit` whose resolved path
leaves the project root, returning a plain-English reason surfaced to the
model (ADR-0018). Freeform bash/ipython confinement is the OS-sandbox tier,
recorded as a follow-up.
**Skill capture**:
The procedural-memory skill pipeline (ADR-0020, step 1): turning a completed
task that was flagged reusable into a durable `SKILL.md` that bundles the task
prompt + its ordered steps + provenance (`metadata.provenance`), verified to
load via the real skill loader before it is offered. The agent supplies the
steps; capture only materializes a skill directory. Later steps add automatic
flagging, an AST-level security audit of third-party skills, and hub/sync over
agentskills.io.
_Avoid_: Skills (the refinement harness's `skill` entries, which are in-memory
harness lineage, not on-disk skill directories)

**Drift**:
An agent acting outside its project's identity, context, or boundary — wrong
files, wrong memory, wrong ledger. Prevented by the anti-drift ladder
(identity → context → root guard → process), never by prompting alone.
_Avoid_: Confusion, contamination (contamination is the mechanism, not the
category)

**Sandbox (confinement)**:
The ADR-0019 OS-tier strict tier: an anchored gateway run (projectRoot set)
spawns the whole completion child inside a bubblewrap sandbox — host mounted
read-only except the project root and the persistent stores (AXIOM_HOME,
~/.prime) bound writable; /tmp /run /var and the CREDENTIAL dirs (~/.ssh,
~/.aws, ~/.gnupg, ~/.netrc) shadowed as tmpfs. Tooling dirs (~/.local, ~/.config,
~/.cache) stay readable so agents keep full bash/tooling and web research; a
per-project shadowDir override tunes this. Freeform bash and the ipython kernel
inherit the mount namespace, so one kernel boundary confines them; the child is
marked AXIOM_CONFINED=1 and replies open with [sandbox-confined]. Fail-closed
when bwrap is absent. Follow-ups (honest): read-minimal allowlist; network
isolation is opt-in per project, off by default (agents need the web).
_Avoid_: Jail, container (not a full container; a mount-ns confinement)

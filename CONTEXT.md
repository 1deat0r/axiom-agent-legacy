# Axiom

An agent framework forked from **Prime Agent v0.7.2** (MIT, PrimeIntellect-ai;
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

**Role label**:
One of five labels on every issue. Set it in the create command; exactly one
at all times (`docs/agents/triage-labels.md`).
_Avoid_: Status, state

**Readiness contract**:
The five parts an issue body needs before `ready-for-agent`: goal, acceptance
criteria, scope, ADR status, verification plan.
_Avoid_: Spec, ready bar

**Close ritual**:
The audit comment (merge commit, ADR, handoff) that precedes every issue
close (`docs/agents/issue-tracker.md`).
_Avoid_: Done note

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
**Command menu**:
The roster of the axiom CLI's public subcommands. `COMMAND_SPECS` in
`cli/command-registry.ts` is the single source of truth; `axiom help`, help
routing, recognized-subcommand routing (`PUBLIC_COMMAND_NAMES`), and shell
completion are all derived from it (ADR-0030). `profile`, `projects`, and
`completion` are public roster entries routed to their own CLI gates, never
to the model.
_Avoid_: Hardcoded help text, parallel dispatch that bypasses the registry

**Shell completion**:
`axiom completion bash|zsh` printed completion for the axiom CLI, computed at
runtime from `COMMAND_SPECS` (+ the active profile's project names) by
`cli/completion-command.ts` (ADR-0030). It reads the roster on every `<Tab>`,
so it cannot drift from the menu.
_Avoid_: Static completion lists, generated scripts that go stale

**Channel**:
A conversation's stable address on a messaging platform (gateway, ADR-0001;
signal gateway shipped ADR-0016).
_Avoid_: Thread, room, conversation id

**Session**:
A single agent conversation: its system prompt, message history, and any
memory or skills context loaded for it. One channel maps to one session.
_Avoid_: Thread, chat

**Session budget**:
The gateway's soft cap on how large a channel session file may grow
(`GATEWAY_SESSION_BUDGET_BYTES`, 256KB of JSONL, ADR-0041): a session past
the cap is archived in place (`<id>.jsonl.archived-<ts>`, still found by
`/search`) and the next run starts fresh, so replies never re-process a
runaway history. `/new` archives on demand.
_Avoid_: Context window, auto-compaction (the budget is a file-size gate,
not a token limit)

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
**Memory consolidation**:
The declarative-memory half of "gets smarter over time" (ADR-0040, issue #19):
after a run, an inert-by-default `agent_end` extension (enabled via
`AXIOM_MEMORY_CONSOLIDATION=1`) has the model propose durable facts
(`{title, content, path}`) from the finished session, filters them through a
deterministic durability gate (length bounds, transient phrasing like "this
session"/"currently"/"todo", dedup against existing global harness memory),
then either stages them for operator confirmation (`axiom
memory-consolidation pending|show|approve|reject|audit`) or — with
`AXIOM_MEMORY_CONSOLIDATION_AUTO=1` — applies them to the global harness
memory with a full audit trail (`<AXIOM_HOME>/consolidation/audit.jsonl`).
Applied entries carry `source: "consolidate"` and are rollback-able through
the refinement history. Pairs with skill capture: tasks → skills
(procedural), facts → harness memory (declarative).
_Avoid_: Recall (the read path over past sessions); refine (manual harness
editing — consolidation is automatic and gated, not invoked)

**Skill capture**:
The procedural-memory skill pipeline (ADR-0024, step 1): turning a completed
task that was flagged reusable into a durable `SKILL.md` that bundles the task
prompt + its ordered steps + provenance (`metadata.provenance`), verified to
load via the real skill loader before it is offered. The agent supplies the
steps; capture only materializes a skill directory. Automatic flagging
(ADR-0026) scores a completed task trace (`evaluateTaskForCapture`) and
captures only when reusable; a builtin `agent_end` extension (ADR-0027) runs
it unattended (inert unless AXIOM_SKILL_CAPTURE_AUTO=1). Hub/sync over
agentskills.io remains.

**Skill audit**:
The security half (ADR-0025, step 2): statically inspecting a skill directory
before a third-party skill is run/installed. Python is parsed at the AST level
(subprocess `python3` `ast`), JS/shell/markdown structurally; a conservative
verdict (BLOCK / WARN / ALLOW) is derived. Bundled first-party skills are
allowlisted by the operator. Surfaces as `auditSkill(dir)` and the
`axiom skill-audit` CLI.
_Avoid_: Skills (the refinement harness's `skill` entries, which are in-memory
harness lineage, not on-disk skill directories)

**Skill check**:
The validation half of hand-written skills (ADR-0037): `runSkillCheck(dir)` and
the `axiom skill-check [dir ...] [--json] [--strict]` CLI run a skill directory
through the REAL loader path (explicit skill path, defaults disabled, so name
collisions dedupe exactly as in a session) and report every file the loader
would drop — missing or empty description, unparsable frontmatter, collision
loser — plus warnings (e.g. name mismatches). The verdict is derived from the
loader's own output, so the check cannot drift from loader semantics; exit
code 1 means a written skill would be silently missing from the next session's
prompt. No directory argument checks the default skill dirs. Motivated by a
hand-written skill (`tui-pty-testing`) shipped without frontmatter and dropped
with a "description is required" warning.
_Avoid_: Skill audit (the security verdict, ADR-0025), Skill capture (the
procedural-memory pipeline, ADR-0024)

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
~/.axiom/agent) bound writable; /tmp /run /var and the CREDENTIAL dirs (~/.ssh,
~/.aws, ~/.gnupg, ~/.netrc) shadowed as tmpfs. Tooling dirs (~/.local, ~/.config,
~/.cache) stay readable so agents keep full bash/tooling and web research; a
per-project shadowDir override tunes this. Freeform bash and the ipython kernel
inherit the mount namespace, so one kernel boundary confines them; the child is
marked AXIOM_CONFINED=1 and replies open with [sandbox-confined]. Fail-closed
when bwrap is absent. Follow-ups (honest): read-minimal allowlist; network
isolation is opt-in per project, off by default (agents need the web).
_Avoid_: Jail, container (not a full container; a mount-ns confinement)

**Security fence**:
The ADR-0028 rung-3 amplification, on the same `tool_call` seam as the root
guard and inert unless anchored: a URL-safe fetch gate (blocks malformed,
non-http(s), credential-bearing, and SSRF-prone URLs — loopback/private/link-
local/ULA/v4-mapped hosts, resolved hostname SSRF pending DNS follow-up) plus a
sensitive-tool fence (a configurable approved-tool ladder, opt-in, escaped via
`AXIOM_FENCE_ALLOW`/`AXIOM_FENCE_ALLOW_HOSTS`). Freeform `bash`/`ipython` stay
the ADR-0019 OS-sandbox tier, never string-fenced.
_Avoid_: Firewall (a wall, not a fence — the fence is one rung of the ladder)

**Git guard**:
The ADR-0049 rung-3 addition, on the same `tool_call` seam and inert unless
anchored: `checkGitCommand` scans the freeform shell tools (`bash` command,
`ipython` code) against a port of the git-guardrails skill blocklist (push in
all forms, reset --hard, clean -f variants, branch -D, checkout/restore ".")
and blocks with a reason that names the pattern and the escape. Best-effort by
design (not confinement — that stays ADR-0019); escaped via
`AXIOM_GIT_GUARD_ALLOW` (exact commands) or the operator's own terminal;
`user_bash` stays unguarded (the operator has authority).
_Avoid_: Sandbox, confinement (a guard, not a wall — the OS tier stays the wall)

**Completion resilience**:
The ADR-0051 gateway defense-in-depth: transient completion failures (SIGTERM
143, SIGKILL 137, timeout, busy session, spawn error) are classified
(`completion-failure.ts`) and retried once with compaction dropped, streaming
into the same bubble; the user-facing failure text is one short sentence and
never the command line. Telegram re-deliveries of the same (text, date) are
deduped in-window, the post-/update restart waits for in-flight runs, and
compact-before runs get their own longer timeout. Env knobs:
`GATEWAY_COMPLETION_TIMEOUT_MS`, `GATEWAY_COMPACT_TIMEOUT_MS`,
`GATEWAY_COMPLETION_RETRIES`, `GATEWAY_COMPLETION_RETRY_DELAY_MS`,
`GATEWAY_RESTART_GRACE_MS`, `GATEWAY_MESSAGE_DEDUP_MS`.

**Self-update**:
The gateway-local `/update` command (ADR-0034): fetch + report, or `/update
now` to fast-forward the configured worktree (`AXIOM_UPDATE_REPO` /
`--update-repo`, branch `main`) and rebuild the axiom bundle, then restart
the gateway process — systemd `Restart=always` brings it back on the new
build, and the transport offset cursors persist, so no message is lost or
replayed. Gated: clean worktree, on `main`, ff-only merge, build exit 0;
any failure leaves the old code serving and never restarts.
_Avoid_: Deploy script (the runner is typed, tested, gate-checked in-repo)
**Model hotswap**:
The gateway-local `/model` command (ADR-0033): a persisted per-profile
active-model override (`{provider, model}` under
`<AXIOM_HOME>/gateway/model-<profile>.json`) that the gateway injects as
`--provider/--model` into every subsequent completion, so the operator can
switch the agent's model from the chat without a restart. Provider may be
empty ("keep the profile's provider"); `/model clear` reverts to the profile
default. The CLI stays the model authority — availability is validated on the
next completion, not by a gateway-side catalog.
_Avoid_: Settings edit (the store is an override, not the profile's config)

**Connectors**:
The terminal `/connectors` command (ADR-0036): a boxed two-level menu that
connects messaging platforms — signal (signal-cli), telegram, discord, slack
(bot tokens) — to the gateway. Pick a connector (each labeled with its live
status: active / token set / no token / signal-cli found), then an action:
Status & setup guide, Set bot token (a boxed paste field; written to the
gateway systemd unit's `Environment=` line and the env file, never echoed), or
Use now (rewrite the unit's `--transport`, daemon-reload, restart — guarded
against missing tokens and against restarting the service from inside its own
cgroup). `/connectors status` and `/connectors help <name>` print the same
state without a menu. The service name is `AXIOM_GATEWAY_SERVICE` (default
`axiom-telegram-gateway.service`).
_Avoid_: Transport flag (a connector is the transport plus its credential)

**Peer coordination**:
Instances of axiom-agent anchored to the same project root (AXIOM_PROJECT_ROOT)
see and talk to each other (ADR-0038). Each axiom home has a stable instance ID
(`<home>/instance-id.json`); per-process run IDs distinguish concurrent runs.
Coordination state lives under `<home>/peers/<sha256(realpath(root))[:12]>/` —
never inside the repo tree. Presence files carry pid/model/intent/heartbeat;
liveness is pid existence plus heartbeat freshness (default 5 min), so crashed
instances go stale on their own. An append-only JSONL board carries directed
messages (`to=<instanceId>`) and group messages (`to="*"`, visible to every
live instance — the group chat); each instance tails the board from a
byte-offset cursor. Agent tools: peers_list, peers_send, peers_inbox,
peers_intent; CLI: `axiom peers [list|inbox]`, `axiom peers msg <id|*> <text>`,
`axiom peers group <text>`. Inert unless anchored; zero new dependencies.
_Avoid_: Harness sub-agents (RLM children are parent-to-child, not siblings)

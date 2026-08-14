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

**Stale branch**:
A branch whose work is on main or that no open issue references; the closing
agent deletes it (`docs/agents/stale-branches.md`, ADR-0064).
_Avoid_: Old branch, dead branch

**ADR**:
A numbered decision record for this repo's architecture and process choices
(`docs/adr/ADR-00NN-<slug>.md`; the series continues from the baseline's
ADR-0015 restart). The number is the registry's primary key — it appears in
CONTEXT.md terms, issue titles, commit messages, and handoffs.
_Avoid_: Design doc, RFC, doc note (an ADR records a decision, not a summary)

**ADR reservation**:
The ADR number an issue claims at create time, written in the issue title
(`(ADR-00NN)`). Reservations are unique and ordered: the next open issue takes
the lowest number the registry does not hold and no other open issue reserves.
The merging agent verifies the ADR file's number equals the issue's
reservation; a collision is resolved by renumbering the later reservation.
_Avoid_: Free allocation at branch time, first-write-wins (parallel branches
cannot see each other's ADR files, so allocation must happen in the tracker)

**Renumber**:
The collision-resolution edit that changes an ADR's number: rename the file,
update the title's `(ADR-00NN)`, and fix every reference (CONTEXT.md terms,
commit messages, handoffs). The later reservation yields; the earlier keeps
its number.
_Avoid_: Reuse (a renumber never frees a number for another claim)

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
the cap requests pre-run compaction (the completion child summarizes the
context, so replies never re-process a runaway history); `/new` archives
the file on demand (`<id>.jsonl.archived-<ts>`, still found by `/search`).
Since ADR-0055 this is the safety limit; the session token meter is the
primary trigger.
_Avoid_: Context window, auto-compaction (the budget is a file-size gate,
not a token limit)

**Session token meter**:
The gateway's estimate of the model-facing surface of a channel session
(`measureSessionTokens`, ADR-0055): reads the session JSONL and prices
every message entry. Since ADR-0060 it resolves a real tokenizer per
provider/model family (gpt-tokenizer: o200k_base for openai's modern
models, cl100k_base for openai classic models and every deepseek model);
providers without a registered tokenizer fall back to the ADR-0055
fixed-density heuristic (one token per 4 characters plus block and role
overhead) with a warning. A session whose surface exceeds
`GATEWAY_SESSION_TOKEN_BUDGET` requests pre-run compaction. Snapshots are
immutable and carry a revision (entries consumed).
_Avoid_: Token-based billing (the meter estimates; it never reads provider
usage), per-message exactness (the system-prompt envelope stays unpriced)

**Stream bubble**:
The single message a streamed gateway reply edits in place as text arrives
(ADR-0047): a reply that outgrows the transport's text cap (4096 chars for
Telegram) rolls over into a NEW bubble instead of breaking the edit. The
batch fallback after a failed final edit sends only the unlanded tail.
_Avoid_: Message (the one-shot send path), edit window (the bubble is the
message, not a window over one)

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
The ADR-0014 rung-3 enforcement: axiom extensions, inert unless a run is
anchored by AXIOM_PROJECT_ROOT, that confine the file-touching tools to the
project root. The workspace guard (ADR-0018) blocks an `edit` whose resolved
path leaves the root (applying the same `~` expansion the edit tool does).
The root guard (ADR-0052) scans `bash`/`ipython` for literal AND decoded path
tokens (shell-escaped slashes, ANSI-C `$'...'`, `file://` URIs) and blocks,
by default, ANY outside path — strict block-by-default; cells with
obfuscation markers and no inside-root path fail closed, destructive
coreutils with a bare-root operand block, and cd/chdir through variable
targets block. The operator relaxes it with `AXIOM_ROOT_GUARD_ALLOW`
(allow prefixes; the exported `INFRA_ALLOW_PREFIXES` list is the opt-in
convenience set) and hardens it with `AXIOM_ROOT_GUARD_DENY` (wins
everywhere, and the operator-owned store — default
`/var/lib/axiom-root-guard` — is always denied). Escapes need plain-English
approval: the model files a request
with the `request_root_access` tool and waits; the operator decides with
`axiom root-guard approve|reject <id>`. Every block, request, decision,
grant, and grant-use lands in the audit log under the operator-owned state
dir (`<stateDir>/root-guard/<project-hash>/audit.jsonl`; operator decisions
and grants are HMAC-signed, the agent's events advisory); a decided request
leaves the pending board. Honest boundary: freeform string extraction is
best-effort, not confinement — the ADR-0019 OS sandbox remains the strict
tier.

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
local/ULA/v4-mapped/IPv4-compatible host literals, loopback-patterned hostnames, and, since
ADR-0057, named http(s) hosts whose resolved A/AAAA addresses are private;
resolution failures fail closed; since ADR-0066 the gate re-resolves at
connect time and re-checks, and the gate-owned `fetchPinned` connects to the
checked addresses with the original Host header, re-gating every redirect
hop) plus a sensitive-tool fence (a configurable approved-tool ladder,
opt-in, escaped via `AXIOM_FENCE_ALLOW`/`AXIOM_FENCE_ALLOW_HOSTS`;
allowlisted hosts skip DNS). Freeform `bash`/`ipython` stay the ADR-0019
OS-sandbox tier, never string-fenced.
_Avoid_: Firewall (a wall, not a fence — the fence is one rung of the ladder);
DNS rebinding outside the pinned path (a plain fetch elsewhere still resolves
on its own)

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

**Schedule tools**:
The model-facing reminder tools (ADR-0053): `schedule_after` (positive
delay), `schedule_at` (absolute ISO 8601 instant with an explicit zone), and
`schedule_every` (fixed interval, five minutes minimum) store reminders that
return later as ordinary message turns in the session they were scheduled
from, delivered to the session's channel. The tools exist only on runs the
gateway tagged (`AXIOM_GATEWAY_CHANNEL_ID` + `AXIOM_GATEWAY_SESSION_ID` env),
so nothing promises a reminder it cannot deliver. Records live in an
append-only JSONL store at `<AXIOM_HOME>/gateway/schedule.jsonl` (agent
appends reminders, the gateway appends fire records; the fold replays the
log). The gateway's `ScheduleManager` sweeps on boot (a reminder missed while
down fires exactly once) and every `GATEWAY_SCHEDULE_POLL_MS` (default 10s),
fires each due reminder once, and re-schedules recurring ones at their
earliest future slot; each fire becomes a completion turn on the channel's
serialization chain in the stored session. Reminders that cross sessions,
operator cron changes, and delivery to other channels are out of scope.
_Avoid_: Operator cron (the gateway /cron spine is separate and stays separate)

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

**Live verification**:
The operator-gated harness for the live passes the ADRs defer (ADR-0058):
`tools/live-verification/run.mjs` catalogs four checks (provider-chat,
agent-run, rlm-kernel, gateway-delivery) and runs the subset whose keys are
present. The exit contract is skip-not-fail: a check with missing requirements
is SKIPped with the reason named, all-SKIP is exit 0, and exit 1 means exactly
"a check that ran failed". The workflow
(`.github/workflows/live-verification.yml`) runs it on dispatch or a PR
`/run-live` comment and posts the PR report only when something ran, so keyless
runs stay silent. `docs/live-verification.md` holds the operator ledger: one
checkbox per ADR follow-up that defers a live pass to the operator.
_Avoid_: CI test (it is an operator gate, not part of the default matrix)

**Transport limits**:
The gateway's transport breadth contract (ADR-0062): Slack receive is REST
long-poll by default, or Socket Mode (websocket) when `SLACK_SOCKET_MODE=1`
with `AXIOM_SLACK_APP_TOKEN` — Socket Mode frames are treated as untrusted
input (validated, replay-cached, url-confined to `wss:` on slack.com, secrets
redacted from logs; a 9-case threat corpus pins it). Broadcasts (`/announce`,
`deliverToAll`) reach every active transport: a `deliverTo` entry that names a
transport goes there alone, an unnamed entry goes to the primary and every
built fan-out sibling, each labelled by its own name in the delivery ledger.
`docs/transport-audit.md` is the honest inventory of every Discord/Slack/Signal
path with status live / built-not-live / paper.
_Avoid_: Single-transport assumption (broadcasts are multi-platform now)

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

**Session stall watchdog**:
Two hang detectors so no agent stalls silently (ADR-0067, issue #44): (1) the
stream watchdog in the agent loop measures no-data time between provider
chunks — a stream that delivers nothing for `AXIOM_STREAM_STALL_TIMEOUT_MS`
(default 120s) is aborted, retried once (`AXIOM_STREAM_STALL_MAX_ATTEMPTS`,
default 2), and a repeated stall fails the turn with a recorded error;
flowing generations are never cut. (2) RLM child liveness marks a running
child `stalled` in rlm.list_subagents, the live child snapshots, and the
agents view when its session dir has had no writes for
`AXIOM_RLM_CHILD_STALL_MS` (default 10 min); cancellation stays a parent
decision (rlm.delete_subagent). Both knobs accept 0 to disable; invalid
values fall back to defaults.
_Avoid_: Gateway completion retry (ADR-0051 covers a child that dies; the
watchdog covers a child that hangs); generation-length limit (the watchdog
bounds silence, not output)

**Ralph handoff**:
The bounded structured report a delegate helper ends its run with (issue #33,
ADR-0054): five capped fields — status, summary, evidence, next steps,
blockers — parsed from the helper's final reply into `DelegateResult.handoff`.
The helper prompt (`buildHelperPrompt`) asks every helper for it; helpers that
omit it still return the old compact result. Field caps (status 100, summary
2000, up to 8 evidence items of 500 chars, 8 next steps of 300, 8 blockers of
300) keep the block bounded no matter what the helper returns.
_Avoid_: Transcript, full log, raw summary (the handoff is the structured,
capped projection; the summary field stays the raw capped closing text)

**Runtime GC**:
Garbage collection for the persistent Python kernel (ADR-0059). The runtime
module `rlm.gc` measures pressure (cheap per-generation counters; detailed
adds tracked-object counts, estimated bytes, and the user-namespace reachable
closure) and runs full cyclic passes; the rlm bootstrap cell installs a
`post_execute` hook that collects once uncollected objects cross
`AXIOM_GC_MAX_UNCOLLECTED_OBJECTS` (env-tunable thresholds). The host can
force passes (`KernelManager.gcPressure` / `collectGarbage`) and, opt-in via
`AXIOM_GC_CHECK_EVERY_N_CELLS` (or `KernelGcOptions.checkEveryNCells`),
attaches per-cell `gc: {pressure, collect?}` metadata to user cell results.
Off by default; cell execution is unchanged without opt-in.
_Avoid_: RSS profiling, memory mapping, object-level deep copies (out of scope)

**Shutdown worker reaping**:
The daemon supervisor's last-resort step at shutdown (ADR-0056). A worker that
survives its stop attempt during shutdown would otherwise leak forever — the
background finalizer is inert once shuttingDown is set. In the
WorkerStopTimeoutError catch, shutdown() does one fresh identity check and
force-kills before exit: current identity signals the process group, unknown
identity gets a group-only SIGKILL (no single-pid fallback, so a recycled pid
cannot be signaled), replaced or gone identities are never signaled.
_Avoid_: Finalizer escalation (that is the normal-operation path, unchanged)

# ADR-0052: Root guard v2 — freeform path confinement and plain-English approval

**Status:** accepted (hardened 2026-08-14 — see "Hardening (2026-08-14)" below)
**Date:** 2026-08-14
**Extends:** ADR-0014 (anti-drift ladder, rung 3), ADR-0018 (workspace root guard),
ADR-0028 (security fence seam), ADR-0019 (OS-tier confinement)
**Implements:** issue #17 (the last unshipped rung-3 step)
**Numbering:** 0052 — main's parallel sessions took 0050 (issue tooling) and
0051 (gateway completion resilience) after this branch was cut.

## Context

ADR-0018 pinned the structured `edit` tool and recorded an honest gap: `bash`
and `ipython` are freeform, so their path escapes belong to the OS-sandbox
tier (ADR-0019). Issue #17 asks for the rung-3 completion on the tool seam:
block-by-default path confinement for the file-touching tools, with escapes
that require **plain-English interactive approval**, zero new dependencies,
inert when not anchored.

In this codebase the file-touching tools are exactly `bash`, `ipython`, and
`edit` (there are no separate read/write tools; freeform reads and writes all
run through the two shell tools). The `tool_call` seam and the
inert-unless-anchored pattern are proven by the security fence (ADR-0028) and
the git guard (ADR-0049). ADR-0028 rejected an interactive approval prompt as
nondeterministic; issue #17 now demands one, so this ADR ships an approval
loop that is deterministic to build and test: a file-backed request/decision
store with a poll-based wait, and operator surfaces that are plain CLI
commands.

## Decision

A **root guard extension** (`packages/coding-agent/src/extensions/root-guard/`,
shipped in the axiom built-ins) plus a pure core module
(`packages/coding-agent/src/core/root-guard/`) shared with the workspace guard.
Inert unless a run is anchored by `AXIOM_PROJECT_ROOT` (or an explicit
`deps.root` in tests) — the same gating as the fence.

**The gate** (`core/root-guard/`): on `tool_call` for `bash`
(`input.command`) and `ipython` (`input.code`), extract candidate path tokens
(absolute paths, `~/` tokens, and relative tokens that carry a slash or a
`.`/`..` segment; shell comments stripped; quotes are token boundaries) and
classify each against the project root:

- Lexically inside the root → allowed (no realpath chase — a worktree's
  `node_modules` symlink resolves outside and would false-block every test
  run; the `edit` guard keeps its realpath check).
- Outside the root → allowed only if it matches an **allow prefix** or an
  **active grant**; a **deny prefix** always wins; otherwise blocked with a
  plain-English reason that names the paths and the approval tool.

**Default policy** (applied by the extension factory, not the pure core):
strict block-by-default — any literal path token outside the project root
blocks, full stop (issue #17 criterion a, taken literally). The operator
relaxes it explicitly: `AXIOM_ROOT_GUARD_ALLOW` (allow prefixes) and
`AXIOM_ROOT_GUARD_DENY` (force-deny, wins over everything, even inside the
root). The module exports `INFRA_ALLOW_PREFIXES` — OS read surfaces (`/proc`,
`/sys`, `/dev`, `/run`, `/usr`, `/bin`, `/lib`, `/lib64`, `/etc`, `/opt`,
`/sbin`), scratch (`/tmp`), and the agent's own homes (the axiom home,
`~/.local`, `~/.config`, `~/.cache`), the same surfaces ADR-0019 keeps
visible — as an OPT-IN convenience list to paste into `AXIOM_ROOT_GUARD_ALLOW`,
never applied automatically. Home data (Documents, other projects, `.ssh`,
`.aws`, `.gnupg`, `.netrc`, dotfiles), `/var`, `/mnt`, `/media`, `/srv`, and
other users' homes have no opt-in entry in that list.

**The approval loop**: a registered tool `request_root_access` takes
`{ paths, reason }` (the plain-English ask). It resolves each requested path
to an absolute path and keeps only those outside the root (paths already
inside are answered with "no approval needed"; paths under a deny prefix are
refused outright — a deny can never be overridden), files a pending request,
then **waits** — polling a decision file (default 500ms interval) up to a
timeout (default 5 minutes, `AXIOM_ROOT_GUARD_APPROVAL_TIMEOUT_MS`),
abortable via the run's signal. On approval the grant is recorded
(idempotently — one grant line per request id, whether the CLI or the
polling tool records it) and the guard lets the retried call pass; on
timeout the tool returns the request id so the model relays it to the
operator, and a grant approved later still applies. A decided request
leaves the pending board (the decision history stays visible). The operator
decides with the CLI: `axiom root-guard list|approve <id>|reject <id>`.
Every block, request, decision, grant, and grant-use (shell tools AND
`edit`) lands in an append-only audit JSONL — an outside path is **never
silently allowed**: it passes by explicit policy or by a recorded,
operator-approved grant. If the approval store itself fails, the gate fails
closed with a plain-English reason instead of letting the call through
unverified.

**State**: `<AXIOM_HOME>/root-guard/<rootHash>/` (`AXIOM_ROOT_GUARD_STATE_DIR`
overrides), root-scoped by `sha256(realpath(root))[:12]` (the peers pattern):
`pending/<id>.json`, `decisions/<id>.json`, `grants.jsonl`, `audit.jsonl`.

**Edit completes the loop**: `decideEdit` gains optional `allowPrefixes` and
`denyPrefixes` (both default none — ADR-0018 behaviour unchanged; deny wins
first, even inside the root, so a sensitive subdir can be sealed). The
workspace extension reads the same allow/deny env and the active grants, so
an approved escape also unblocks the retried `edit`, and edit blocks and
grant-uses are audited like the shell gate. The operator's own `user_bash`
(`!`) commands are never guarded — the guard lives on the agent tool seam,
not on the human (the git-guard precedent, ADR-0049).

## Honest boundary (recorded, not faked)

- String extraction is best-effort: variable indirection (`$HOME`, Python
  `os.environ`), `eval`, process substitution, and rewording pass through.
  This is not confinement — the ADR-0019 OS sandbox remains the strict tier.
- Arithmetic operators are not paths: a bare `/` reads as the root path
  unless it starts a division operand (a name, `$`, `(`, or a digit that is
  not a `>` redirect). Python spaced division (`a / b`, `x = a / (b)`,
  `x = a / 2`) never blocks, while the destructive bare-root forms
  (`rm -rf /`, `rm -rf / --no-preserve-root`, `rm -rf /{x}`, `rm -rf /'`,
  newline/separator continuations, `2>/dev/null`) still do. Recorded
  trade-offs: `cat / b` misses the bare root (reads as an infix operand) and
  `a / -1` over-blocks (unary minus reads as an argument).
- Freeform containment is lexical only; a symlink created inside the root
  that points outside is not chased (documented; the `edit` guard still
  realpaths). `~-` (bash OLDPWD) is likewise resolved lexically inside the
  root while the shell would expand it to a possibly-outside directory — the
  same recorded lexical boundary. The persistent ipython kernel can `cd` into an allowed
  directory and read relative paths that carry no slash token, silently —
  bounded by policy (a `cd` to a non-allowed directory is itself blocked),
  and recorded here rather than hidden.
- Approval is interactive through the model's relayed text plus the operator
  CLI. Inline approve buttons in the gateway are a follow-up (the gateway is
  single-threaded while a completion runs).
- No live model/provider verification in this sandbox — verification is unit
  plus mock, recorded as such.

## Alternatives considered

- **Default infra allowlist (relaxed default).** Rejected: criterion (a) of
  issue #17 demands block-by-default, and a silent default allow would weaken
  "never silently allowed". Anchored runs bootstrap once — the first `/tmp` or
  axiom-home touch files a plain-English request the operator approves, and
  the grant persists; operators who want the practical posture up front paste
  `INFRA_ALLOW_PREFIXES` into `AXIOM_ROOT_GUARD_ALLOW`.
- **Realpath containment for freeform tools.** Rejected: worktree
  `node_modules` symlinks resolve outside the root and would false-block the
  standard test workflow.
- **Gateway inline approve buttons in this increment.** Rejected: the gateway
  cannot process an inbound reply while the completion child blocks; the
  transport rework is a recorded follow-up.
- **Approval prompt at block time (interactive stdin).** Rejected: the agent
  runs headless (gateway/RPC); the file-backed loop works everywhere and is
  deterministic to test.

## Consequences

- On an anchored run, `bash`/`ipython` calls that reference ANY path outside
  the project root are blocked by default (criterion a); escapes require a
  plain-English request an operator approves or rejects.
- CONTEXT.md's Root guard term is updated to cover the full rung-3 gate.
- Follow-ups stay recorded: gateway inline approval, a per-project escape
  config file (obfuscation-hardening landed in the hardening section below;
  confinement was never claimed — the ADR-0019 OS sandbox is the strict tier).

## Hardening (2026-08-14)

An adversarial red-team pass (S-class threat corpus, review-rubric.md) found
seven blocker families against the shipped gate. The hardening below closes
every one that is closable on the tool seam and amends the honest boundary to
match. Red-first corpus: `test/extensions/root-guard-attack-corpus.test.ts`
(62 permanent cases, exact red-team inputs plus documented positive controls).

**B1 self-approval — closed.** The store lived under the axiom home, inside
the agent's reachable namespace: `%cd $HOME/.axiom` (the `$` gap) plus a
relative-path write could forge grants and erase the audit. Now:

- The default state dir is **operator-owned and outside the agent's reach**:
  `/var/lib/axiom-root-guard` (`AXIOM_ROOT_GUARD_STATE_DIR` overrides; the
  operator provisions the directory — `mkdir -m 700` — or points the env var
  elsewhere; the agent's home is never the default). OS-level separation (a
  different uid for the store) remains the strict tier.
- **Grants and decisions are HMAC-signed.** The key (`<scopeDir>/.hmac-key`,
  mode 0600) is created ONLY by the CLI (`loadOrCreateKey`); the guard never
  creates or writes it. `listGrantPrefixes` and `readDecision` verify every
  signature and treat unsigned/invalid entries as ABSENT, so an agent-written
  forgery can never become an allow. The agent's polling loop no longer
  writes grants at all — the CLI's approve command owns the signed grant.
- **The store is hard-denied on every seam**: the state dir and the legacy
  `<axiom home>/root-guard` location are implicit deny prefixes (lexical AND
  realpath-resolved), winning over allow prefixes and grants, in both the
  shell gate and the edit guard.
- **cd/chdir drift is blocked**: a `cd`/`%cd`/`chdir` whose target is a
  variable, environment reference, or substitution blocks outright, so the
  kernel cwd cannot be moved outside the root without a literal, judgeable
  path.
- The audit file stays in the state dir with the same protection. Honest
  split: the operator's decision/grant events are SIGNED (the authoritative
  record); the agent's block/request/grant-use events are advisory
  (`writer: "agent"`, unsigned) — the agent cannot forge an allow either way,
  and the CLI flags unverified decision records.

**B2 slash-spelling obfuscation — closed in two layers.** (a) DECODE before
extraction: `\/` (always a shell-escaped slash) and ANSI-C `$'...'` hex/octal
escapes are decoded, so those forms extract their real path and face the
normal gate. (b) POSTURE FLIP for the residual: a cell carrying obfuscation
markers (command substitution, ANSI-C quoting, `\xNN`/octal escapes,
backslash-escaped path characters, `$VAR/`-prefixed paths, `chr(47)` and
`chr()`/`codecs`/`__import__`/home-env tricks near path strings) and naming
NO known-inside token is BLOCKED with a plain-English reason directing to
`request_root_access`. Perfect parsing is impossible; the guard fails closed
on ambiguity. The plain `$HOME`-prefixed read (`cat $HOME/.ssh/id_rsa`) is
also closed by the `$VAR/` marker. False-positive cost (e.g. a standalone
`$(...)` cell with no inside path) is recorded and intentional: the model
rewords or requests approval.

**B3 destructive bare-root with trailing operands — closed.** A destructive
binary list (`rm`, `chmod`, `chown`, `cp`, `find`, `shred`, `dd`, `mv`,
`chroot`) with a bare-root `/` operand blocks outright, trailing words or
not, on the bash seam and on `%%bash`/`!` lines inside ipython cells. The
arithmetic-division exemption is unchanged for the ipython seam. The root
path can never be approved through `request_root_access`.

**B4 edit-seam tilde escape — closed.** `decideEdit` expands `~`/`~/` (and
strips a leading `@`) with the SAME rule the edit tool itself applies
(`resolveToCwd` -> `expandPath`) before the realpath checks, and prefix
matching uses the same expansion, so `~/.ssh/id_rsa` and `~/Documents/...`
block exactly like the tool would resolve them.

**B5 symlink chain and B6 `file://` URI — closed.** The symlink-target
construction forms (`ln -s "$(printf '\x2fetc')"`, `ln -s $HOME/.ssh`) are
caught by the B2 marker flip, and `file://` URIs are extracted as their path
part (`file:///etc/passwd` -> `/etc/passwd` -> gate). Residual: a symlink
created by the OPERATOR (or pre-existing in the root) is still lexically
transparent — containment stays lexical, recorded below.

**B7 request breadth — closed.** `request_root_access` refuses to file
requests for `/`, the operator's home, or the axiom home (those are
operator-CLI-only), and caps a request at 64 paths. The CLI `list` now shows
active grants and flags unverified decision records.

### Amended honest boundary (replaces the pre-hardening paragraph)

- The gate blocks literal AND decoded path tokens and fails closed on
  obfuscation-marked cells that name no inside path. It is still NOT
  confinement: variable indirection without a slash suffix, `eval`-built
  paths, rewording, and multi-step compositions are residual; the ADR-0019
  OS sandbox is the strict tier.
- Containment for the freeform tools stays lexical (no realpath chase), so a
  symlink that exists inside the root can still point outside; the edit tool
  keeps its realpath check. The persistent ipython kernel's cwd is anchored
  by construction and cd-drift is blocked; a cwd moved by an UNGUARDED path
  (operator's own terminal, pre-existing state) is residual.
- The store is operator-owned and HMAC-signed; the agent cannot forge an
  allow, but on a single-uid deployment it can still erase the audit
  (advisory events) or remove the store (fail-closed DoS). A different uid
  for the store, or the ADR-0019 sandbox, closes that residual.
- Approval remains interactive through the relayed text plus the operator
  CLI; inline approve buttons are still the gateway follow-up.

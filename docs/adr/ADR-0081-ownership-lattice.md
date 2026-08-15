# ADR-0081: The ownership lattice — pin/protected/curator-managed writes

**Status:** accepted
**Date:** 2026-08-15
**Issue:** #55 (ADR-0081 reservation)
**Implements:** ADR-0078 decision 2 (the Hermes-model guardrail), port order step 2
**Extends:** ADR-0080 (/learn — its staged captures are the first install consumer), ADR-0024 (capture), ADR-0027 (runtime hook)

## Context

ADR-0078 set the posture: the loop writes silently only what it owns. What it
owns was decided in principle — curator-managed skills and its own memories —
but never mapped to paths, and nothing in code enforces it. Today the
skill-capture surfaces stage captures into `<AXIOM_HOME>/captured-skills` and
print an instruction ("copy the directory into a skills directory"); a buggy
or over-eager hook could write anywhere, and nothing would stop it. This ADR
turns the decision into a code-enforced map: three layers over the paths
axiom owns, a whitelisted toolset for the learning actor, and an install
primitive that is the first consumer.

## Decision

### The three layers

- **pin** — the floor and the shipped package. No lattice-routed write is
  ever admitted, by any actor: the bundled skills directory, the witness
  audit log, the profile soul, and — when the runtime's cwd is the repo — the
  repo floor (SOUL.md, the test suite, the packages tree that holds the
  ledger's never-guess rule). The witness log's own append-only writer is not
  a lattice-routed write; it is the sanctioned primitive, and pin stays
  absolute for everything else on those paths.
- **protected** — user-owned work: user skills (`<agentDir>/skills`) and
  project skills (`<cwd>/<CONFIG_DIR_NAME>/skills`). Refused for the learning
  actor with a named reason; admitted for operator-routed lattice writes.
- **curator** — the loop's own territory: `<AXIOM_HOME>/captured-skills`
  (staging), `<AXIOM_HOME>/curator-skills` (the new live skills directory),
  `<AXIOM_HOME>/consolidation` (pending staging), and the harness state dir
  (the memory store). Admitted for both actors; the learning actor's writes
  are silent-by-default and audited by the caller.

### Classification and admission

A new core module `core/ownership-lattice/`:

- `classifyPath(target, config)` resolves the lexical path and picks the
  **most specific root** (longest boundary-safe prefix; a file root never
  bleeds into `SOUL.md.bak`). A tie between layers resolves to the stricter
  one (pin > protected > curator). Unmapped paths are `outside`.
- `admitWrite(target, { actor, operation }, config)` applies the hard bounds:
  pin is refused for every actor and operation; the learning actor is
  admitted **only** on curator territory with an operation from
  `LEARNING_ACTOR_TOOLSET` (`memory.apply`, `memory.stage`, `skill.capture`,
  `skill.install`); `outside` is refused for both actors — fail closed.
- `defaultLatticeConfig({ axiomHome, agentDir, cwd, bundledSkillsDir,
  harnessStateDir })` builds the map above from the same constants the
  loaders use (`CONFIG_DIR_NAME`, `getBundledSkillsDir()`,
  `getGlobalHarnessStateDir()`), so the lattice cannot drift from where
  sessions actually read.
- Honest boundary: classification is lexical path policy, not confinement.
  Symlink tricks and races are out of scope — the ADR-0019 OS sandbox remains
  the strict tier.

### The install primitive (first consumer)

`installCapturedSkill({ fromDir, name, toDir }, config)`:

- the source must classify **curator** (a staging ground), else refused;
- a **curator** target (curator-skills) admits: recursive copy, no-overwrite,
  then verification through the **real** skill loader (the ADR-0024 proof);
- a **protected** target is refused with the manual alternative — the loop
  names the exact `cp -r` command but never runs it;
- **pin** and **outside** targets are hard refusals.

### The live curator skills directory

`<AXIOM_HOME>/curator-skills` is the loop's live skills directory. It is
loaded into sessions through the existing `resources_discover` extension seam
(emitted by the skill-capture extension when the directory is present), so
installed curator skills actually run — with user/project skills winning name
collisions, the same precedence the lattice encodes.

### Consumer wiring (follows the core module)

- `/learn` (ADR-0080): after a capture, the report states the lattice verdict
  and performs the curator install on request — user-invoked, so it is not
  governed by silent-by-default.
- The ADR-0027 hook: auto-captures may auto-install into curator-skills
  (curator → curator, silent, audited); protected targets are never touched
  unattended.
- Memory consolidation: its existing writes (harness memory, pending staging,
  audit) already land in curator + witness territory; when the lattice lands,
  those paths get an `admitWrite` check that admits them unchanged.

## Considered and rejected

- **Fully-agent-owned safety** — already rejected in ADR-0078; this ADR is its
  code.
- **OS-level enforcement inside the lattice** — rejected: ADR-0078 calls for
  code-enforced hard bounds; the sandbox stays the strict tier and the
  boundary is recorded, not faked.
- **Pinning the whole runtime cwd** — rejected: axiom runs in arbitrary
  projects; the repo floor is pinned by its specific paths and everything
  else is covered by deny-by-default.
- **A pin exception for the audit append inside `admitWrite`** — rejected:
  exceptions erode the pin rule; the witness append is simply not
  lattice-routed.
- **Loop-performed installs into protected dirs after operator approval** —
  rejected: the loop never writes protected paths, even with approval; the
  operator runs the printed command themselves.

## Consequences

- New pure core module `core/ownership-lattice/` (classify, admit, install),
  unit-tested red-first (`test/ownership-lattice.test.ts` is the fence).
- New live directory `<AXIOM_HOME>/curator-skills`, loaded via
  `resources_discover`; absent dirs cost nothing.
- `/learn` and the ADR-0027 hook route installs through the primitive; their
  report text changes from "copy it yourself" to the lattice verdict.
- CONTEXT.md gains the "Ownership lattice" term when the module ships.

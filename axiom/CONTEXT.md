# Axiom — vocabulary (single context)

Axiom is a hardfork of Hermes Agent (NousResearch/hermes-agent, MIT) at HEAD,
tracked upstream and grown past it with sovereign capabilities. The hardfork
is ADR-0087. The Hermes tree is untouched; `git merge upstream/main` stays
clean. Axiom's own layer — this file, SOUL.md, GUIDE.md, the ADR series, and
the port queue — lives under `axiom/`.

## Language

**Baseline**: Hermes Agent at HEAD, the upstream tree this repo hardforks;
remote `upstream` (NousResearch/hermes-agent) merged routinely. Hermes's own
root `AGENTS.md` is the authoritative development guide for the Python core.
_Avoid_: prime-agent (the archived predecessor, `archive/prime-v0.7.2`); pi
(the archived pi fork, `archive/pi-v0.84.1`).

**Port**: The act of re-implementing an archived Axiom capability on the
Hermes baseline, red-first, one tracker issue per port (axiom/docs/ports.md).
The prime-era ADR series (0015–0086) is the spec for the ports. _Avoid_:
Migration, rewrite.

**Sovereign layer**: 3V0's store-first identity/memory/skills substrate
(`3v0/core/`), ported to TypeScript as a plugin + CLI, byte-compatible with
3V0's JSON stores. The profile is a derived view; the store is canonical
(axiom/docs/handoff-sovereign-ts.md). _Avoid_: the Hermes runtime (we do not
rewrite Hermes core).

**The four sources** (ADR-0087): chassis = Hermes (narrow waist, footprint
ladder, self-improving loop); autonomy + durable state = Prime Agent (RLM +
Continual Harness); composability = DeepSeek Harness (plugin-first, Cordis);
build discipline + provenance = Grok Build (pinned toolchain, SOURCE_REV, ACP).

**Footprint ladder**: Hermes's rule for where new capability lands — extend
existing code → CLI command + skill → service-gated tool (`check_fn`) → plugin
→ MCP server → new core tool (last resort). The waist stays narrow; the prompt
cache stays sacred. _Avoid_: new core tool when an edge rung will do.

**ADR**: A numbered decision record (axiom/docs/adr/ADR-00NN-<slug>.md). The
number is the registry's primary key. The series continues across baselines:
prime-era ADRs 0015–0086 remain the port spec; this baseline resumes at 0087.
_Avoid_: Design doc, RFC.

**ADR reservation**: The ADR number an issue claims at create time, in the
title (`(ADR-00NN)`): the lowest number no ADR file holds and no other open
issue reserves. Allocation happens in the tracker, never at branch time. At
merge, the merging agent verifies the file's number equals the reservation;
on collision, renumber the later reservation.

**Axiom home**: Axiom-owned durable state (`AXIOM_HOME`, default `~/.axiom`),
independent of the Hermes baseline by design — it survives a baseline change
(ADR-0015 data-cutover rule). _Avoid_: Hermes home (`~/.hermes`, which Hermes
owns).

**Profile**: A named agent identity (Hermes model): `~/.hermes/profiles/<name>`
holding SOUL.md, sessions, skills, memory. Process-level isolation. _Avoid_:
Persona, account.

**Drift**: An agent acting outside its project's identity, context, or
boundary — wrong files, wrong memory, wrong ledger. _Avoid_: Confusion,
contamination.

## Ported vocabulary (prime-era terms, now port targets)

These were Axiom's prime-era capabilities; on the Hermes baseline they are
**port targets** whose spec is the named ADR, not shipped state — see
axiom/docs/ports.md for live status. Definitions stand unchanged from the
archived CONTEXT.md (commit `8c7b408de`).

- **Cost ledger** (ADR-0010) — per-model token pricing, never-invented spend.
  Hermes has Nous-account billing; the ledger is distinct.
- **Spend cap** (ADR-0011) — a USD ceiling that stops the loop before the next
  LLM call.
- **Memory tool** (ADR-0008) — Hermes ships a memory tool with pluggable
  providers; the sovereign layer adds the store-first canonical JSON + lineage.
- **Root guard / security fence / git guard** — the ADR-0014/0028/0049
  confinement ladder; port status per ports.md.

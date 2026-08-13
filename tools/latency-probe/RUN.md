# Latency probe — A/B turns-per-task measurement

Goal: quantify the P1-P4 latency changes with a fixed workload.

## Recipe

1. Pick a profile with API keys (this sandbox has none — run on the host).
2. Fresh session per run: `axiom --profile <name>` then `/new` (or use a
   fresh project anchor).
3. Run the fixed probe task (verbatim both times):

   > In /tmp/probe-work, investigate axiom-agent's tool-call execution:
   > (a) which file contains executeToolCalls and what line numbers cover it,
   > (b) the default toolExecution mode and where it is set,
   > (c) which built-in tool declares executionMode "sequential" and why,
   > (d) whether file mutations are serialized per file and by what module,
   > (e) one sentence each: what ADR-0043 and ADR-0044 decided.
   > Answer compactly when done.

   This task needs ~6 independent lookups — the P1 guidance should batch
   them, P2 lets non-ipython lookups overlap, P3/P4 don't block them.
4. After the run: `node tools/latency-probe/analyze.mjs <session>.jsonl`
   and record `assistantTurns`, `wallSeconds`, `medianTurnDeltaMs`,
   `thinkingChars`.
5. Baseline = current settings. Then set `"toolTurnThinkingLevel": "low"`
   in the profile settings.json (or `axiom profile edit <name> --settings`),
   repeat, compare. Also eyeball the answer quality (the task has a
   verifiable answer: agent-loop.ts, "parallel" in agent.ts, ipython,
   file-mutation-queue.ts, ADR-0043 = segment planner, ADR-0044 =
   background delegate).

## Success criteria
- Fewer assistant turns per task (batching) and lower wall time.
- Answer quality (all 5 parts correct) does not degrade with
  toolTurnThinkingLevel enabled.

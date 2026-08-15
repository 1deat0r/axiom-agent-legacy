// The write half of the sovereign actuator surface. A decision is a
// store-first mutation — record a fact (optionally superseding an old one) or
// retract one — applied under the caller's cross-process lock, returning a
// JSON-safe result the threev0_record tool hands back to the agent.
//
// Never raises: invalid input returns {error: ...} so the tool surfaces a
// refusal instead of crashing the subprocess. persist=false is the dry-run
// mode (mutations land in memory only, nothing written to disk).

import type { Kind, MemoryStore } from "./memory.ts";
import { factDict, type FactView } from "./query.ts";
import { RecordError, record, type RecordResult } from "./record.ts";

const VALID_KINDS: readonly Kind[] = ["memory", "user", "identity", "directive"];

export interface Decision {
  action?: string;
  kind?: string;
  content?: string;
  fact_id?: string;
  supersedes?: string;
  source?: string;
}

export interface DecideResult {
  error?: string;
  ok?: boolean;
  action?: string;
  fact?: FactView;
  superseded_ids?: string[];
  chain?: FactView[];
}

function recordDecision(
  store: MemoryStore,
  d: Decision,
  source: string,
  persist: boolean,
): DecideResult {
  const kind = (d.kind ?? "").trim();
  const content = (d.content ?? "").trim();
  if (!(VALID_KINDS as readonly string[]).includes(kind)) {
    return { error: `kind must be one of ${JSON.stringify(VALID_KINDS)}, got ${JSON.stringify(kind)}` };
  }
  if (!content) {
    return { error: "content is required for action='record'" };
  }

  const supersedeId = (d.fact_id ?? "").trim() || undefined;
  const supersedeContains = (d.supersedes ?? "").trim() || undefined;
  let result: RecordResult;
  try {
    result = record(store, content, kind as Kind, source, { supersedeId, supersedeContains, persist });
  } catch (err) {
    if (err instanceof RecordError) {
      return { error: err.message };
    }
    throw err;
  }

  return {
    ok: true,
    action: "record",
    fact: factDict(result.fact),
    superseded_ids: result.supersededIds,
    chain: result.chain.map(factDict),
  };
}

function retractDecision(
  store: MemoryStore,
  d: Decision,
  source: string,
  persist: boolean,
): DecideResult {
  const factId = (d.fact_id ?? "").trim();
  if (!factId) {
    return { error: "fact_id is required for action='retract'" };
  }
  const existing = store.get(factId);
  if (existing === null) {
    return { error: `no fact with id ${JSON.stringify(factId)}` };
  }
  if (!existing.active) {
    return {
      error:
        `fact ${JSON.stringify(factId)} is already inactive ` +
        "(superseded or retracted); nothing to retract",
    };
  }
  const retracted = store.retract(factId, source, persist);
  if (retracted === null) {
    return { error: `could not retract ${JSON.stringify(factId)}` };
  }
  return {
    ok: true,
    action: "retract",
    fact: factDict(retracted),
    chain: store.history(factId).map(factDict),
  };
}

export function decide(store: MemoryStore, decision: Decision, persist = true): DecideResult {
  const action = (decision.action ?? "").trim();
  const source = (decision.source ?? "").trim() || "foreground";

  if (action === "record") {
    return recordDecision(store, decision, source, persist);
  }
  if (action === "retract") {
    return retractDecision(store, decision, source, persist);
  }
  return { error: `unknown action ${JSON.stringify(action)} (expected 'record' or 'retract')` };
}

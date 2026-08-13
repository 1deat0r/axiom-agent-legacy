# ADR-0038 — Agent peer coordination

Status: accepted

## Context

Multiple axiom-agent instances sometimes work in the same directory — the
shared working tree, parallel sessions, or two terminals on one project. They
currently cannot see each other, so they collide: branch confusion, stray
files, duplicated work. The existing coordination mechanisms are hierarchical
only (delegate helpers, RLM sub-agents), which covers parent-to-child work but
not sibling instances.

## Decision

Give every instance a stable identity and a file-backed coordination layer
scoped to the project root:

- **Identity**: an instance ID is generated once per axiom home and stored at
  `<home>/instance-id.json`. A per-run ID distinguishes concurrent runs of the
  same profile. Instances are addressed by instance ID (short ID for display).
- **Scope**: coordination state lives under
  `<home>/peers/<sha256(realpath(projectRoot))[:12]>/` — never inside the repo
  tree. The layer is inert unless the run is anchored by AXIOM_PROJECT_ROOT,
  the same seam the security fence and recall use.
- **Presence**: each run writes `<scope>/presence/<runId>.json` (pid, model,
  intent, startedAt, heartbeatAt) and heartbeats on turn boundaries. A peer is
  live iff its pid exists and its heartbeat is fresh (default 5 minutes).
  Crashed instances therefore go stale automatically; idle ones honestly show
  as stale rather than live.
- **Board**: one append-only JSONL file `<scope>/board.jsonl` is the message
  bus. Directed messages carry `to=<instanceId>`; group messages carry `to=*`
  and are visible to every live instance — that is the group chat. Each
  instance keeps a cursor file and tails the board, so no fan-out or inbox
  files are needed and 3+ participants fall out for free. Malformed lines are
  skipped but the cursor still advances (a bad line must not wedge the tail).
- **Surfaces**: agent tools `peers_list`, `peers_send`, `peers_inbox`,
  `peers_intent` (the model is nudged, via tool prompt guidelines, to check
  peers before mutating the shared working tree) plus a CLI `axiom peers
  [list|msg|group|inbox]` that reads and writes the same state. Unread peer
  messages notify the user at turn start; the model reads them via
  `peers_inbox`.

Zero new npm dependencies; everything is plain files under the axiom home.

## Consequences

- Same-host, same-user scope. Cross-host coordination is out of scope and
  would need a different transport.
- Two runs of the same profile share one instance ID and one inbox cursor;
  the profile model already forbids two agent processes on one home, so this
  is acceptable.
- A hard guard that blocks git mutations while a peer is live in the same
  tree is a deliberate follow-up (it belongs on the security-fence seam, per
  ADR-0028); v1 surfaces peer presence and relies on the model to coordinate.
- fs.watch-based mid-run wakeups are a follow-up; v1 surfaces at turn start
  and via tools.

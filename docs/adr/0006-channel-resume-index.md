# Channel resume index: O(1) re-attachment, meta-scan as migration fallback

Restart re-attachment originally scanned every Session for a matching `channelId` in `meta` (ADR-0001 consequence). This ADR replaces the scan with a maintained `channelId → sessionId` index injected into the gateway, so steady-state restarts re-attach Channels in constant time. The scan remains as the fallback for Sessions mapped before the index existed.

## Decisions

- **The index is a gateway-domain concept, injected not owned.** A `ChannelIndex` interface (`get` / `set` / `remove`) ships with a JSON-file implementation (atomic-ish writes, same discipline as the session and memory stores) and an in-memory one. The gateway stays location-agnostic; the embedder decides where the index persists.
- **The index is written on every mapping** — when a Channel is first mapped to a new Session, and when the meta-scan fallback recovers a pre-index mapping (so that Session is never scanned again).
- **Stale entries are tolerated, not prevented.** The gateway cannot observe Session deletion through the store; on resume, an indexed id whose Session no longer exists is dropped and treated as a miss. The index is self-repairing.
- **The meta-scan is the migration path.** Sessions created before the index existed resume via the scan once, then get indexed. First-run behavior with an empty index is unchanged.

## Status

accepted

## Consequences

- Restart resume is O(1) once every live mapping is indexed; the scan survives as a documented fallback rather than being deleted.
- The index can drift only toward stale entries, which are repaired on first contact.

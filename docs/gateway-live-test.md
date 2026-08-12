# Gateway live test — operator instructions (Signal)

How to bring the Signal gateway up for a real end-to-end message, once the
operator is ready. The implementation is honest: no fake results here — the
actual live Signal send is deferred until the shared signal-cli account is free.

## Prerequisites (done ahead of time)

1. **Sender allowlist** — `<AXIOM_HOME>/gateway/config.json` (for the default
   profile, AXIOM_HOME is `~/.axiom`) lists the owner's number, e.g.:
   ```json
   { "senders": ["+64272811798"] }
   ```
   Already wired in this checkout (operator runtime file; not committed).
   Non-listed senders get a canned denial and never reach the model/commands.
2. **signal-cli with a linked device** for the gateway's own account. Signal
   runs one account at a time: **the shared signal-cli account is currently
   held by another process**, so the live send will run later when that account
   is free (see constraint below).
3. **A working provider** for the completion runner (the CLI's print mode needs
   a model + key).

## The one-command live test

```bash
axiom gateway \
  --transport signal \
  --profile default \
  --signal-account "$SIGNAL_ACCOUNT" \
  --signal-cli "$(command -v signal-cli)"
```

- `--profile default` → the implicit `~/.axiom` home (SOUL.md rides, session
  state + channel index under `<AXIOM_HOME>/gateway/`).
- `--signal-account` → the linked signal-cli account (E.164) the gateway sends
  and receives under; wired to `signal-cli -a <acct>`.
- `--signal-cli` → the binary path (default `signal-cli` on PATH).

Then, from the owner's phone, message the gateway's Signal number. The gateway
routes text (not starting with `/`) to the agent and replies over Signal;
`/help`, `/profiles`, `/projects`, `/soul` are handled gateway-local. Text from
a non-allowlisted number is denied.

## Single-instance account constraint (why the live send is deferred)

A signal-cli account is single-operator: two processes cannot hold the same
account simultaneously (linking + `receive` are exclusive). The shared
signal-cli account is **currently held by another process**, so a live
`axiom gateway` send would collide with it. The live pass therefore runs later,
when that account is released; until then the gateway is verified by its test
suite (fake signal-cli + a real argv shim proving `-a <acct>` is passed).

## What "done" looks like

A message from `+64272811798` to the gateway's number returns: (a) a `/help`
listing for a command message, or (b) the agent's text reply for a normal
message, and unknown senders see the denial. Record the result in
`docs/handoff.md` as a live (not mock) verification.

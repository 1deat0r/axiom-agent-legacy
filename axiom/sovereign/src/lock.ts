// Cross-process lock for the sovereign stores (memory.json / skills.json).
//
// Python's memory.py uses ``flock`` on a `<store>.lock` sidecar. Node's stdlib
// has no flock, so this uses an O_EXCL lockfile with a bounded retry loop and
// stale detection (mtime). Single-host by design, and the Python/TS writer
// families never run concurrently (the bridge plugin points at one script
// family at a time), so no mixed-mode interop with Python's flock is required.

import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

const STALE_MS = 30_000;
const TIMEOUT_MS = 10_000;
const RETRY_MS = 10;

function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

export function withLock<T>(storePath: string, fn: () => T): T {
  const lp = storePath + ".lock";
  mkdirSync(dirname(lp), { recursive: true });
  const deadline = Date.now() + TIMEOUT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lp, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      // Lock is held (or stale). Reclaim if it is older than STALE_MS.
      try {
        if (existsSync(lp) && Date.now() - statSync(lp).mtimeMs > STALE_MS) {
          unlinkSync(lp);
        }
      } catch {
        // Lock vanished or stat raced — retry below.
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out acquiring lock ${lp}`);
      }
      sleepSync(RETRY_MS);
    }
  }
  if (fd === null) {
    // Unreachable: the loop exits only once openSync has succeeded.
    throw new Error(`failed to acquire lock ${lp}`);
  }
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
    try {
      unlinkSync(lp);
    } catch {
      // ignore
    }
  }
}

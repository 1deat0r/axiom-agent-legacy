// Minimal unix-socket listener that mimics a foreign production daemon: it
// binds the given socket path, prints one stdout line, and holds the socket.
// The 4603 scoped-discovery regression spawns this OUTSIDE the sandboxed
// socket dirs and asserts `shutdown --force` never reaches it.
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { APP_NAME } from "../../src/config.js";

// The discovery scan matches on comm == APP_NAME; mirror real daemons.
process.title = APP_NAME;
const socketPath = process.argv[process.argv.length - 1];
if (!socketPath || !socketPath.startsWith("/")) {
	throw new Error("decoy fixture requires an absolute socket path argument");
}
mkdirSync(dirname(socketPath), { recursive: true });
const server = createServer(() => {});
server.listen(socketPath, () => {
	console.log(`decoy-listening ${socketPath} ${process.pid}`);
});
// A production daemon exits on SIGTERM; match that so test cleanup is
// deterministic and the regression mirrors real supervisor behavior.
process.on("SIGTERM", () => process.exit(0));

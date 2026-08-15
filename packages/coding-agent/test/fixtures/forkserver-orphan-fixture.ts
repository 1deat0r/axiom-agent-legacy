// Fixture for the forkserver orphan-cleanup regression: forks a real kernel
// from a fresh forkserver, reports the kernel pid and the socket dir the
// forkserver owns, then idles. The test SIGKILLs this process (an unclean host
// death) and asserts the forked kernel and the socket dir do not linger.
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forkKernel } from "../../src/core/kernel/fork-server.js";

const python = process.argv[2];
const connDir = process.argv[3];
if (!python || !connDir) {
	console.error("usage: fixture <python> <connDir>");
	process.exit(2);
}

const forkserverPrefix = "axiom-forkserver-";
const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(forkserverPrefix)));

try {
	const kernelPid = await forkKernel(python, { connectionPath: join(connDir, "connection.json") });
	// The forkserver's socket dir is created synchronously before forkKernel
	// resolves, so it is visible now. Report only the dirs this process created
	// so a concurrent forkserver in another worker can't confuse the assertion.
	const after = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(forkserverPrefix)));
	const newDirs = [...after].filter((name) => !before.has(name)).map((name) => join(tmpdir(), name));
	// The tsx cli re-execs this fixture as a grandchild of the process the test
	// spawned, so the test must kill the host by pid (its own pid), not by the
	// launcher handle — an unclean SIGKILL here is the "host death" under test.
	console.log(`FIXTURE_PID=${process.pid}`);
	console.log(`KERNEL_PID=${kernelPid}`);
	console.log(`SOCKET_DIRS=${JSON.stringify(newDirs)}`);
	console.log("READY");
} catch (err) {
	console.error(`FORK_FAILED=${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}

setInterval(() => {}, 1000);

// The Python "kernel forkserver": a long-lived template process that pays the
// ~1.2s IPython/ipykernel/rlm import cost once, then forks a ready-to-run kernel
// per request in ~ms. Children inherit the imported module objects via
// copy-on-write, bypassing the (slow, virtiofs-backed) per-file import path.
//
// Embedded as a string rather than shipped as a package asset so it can never be
// missing from a release layout (see the built-in-skills packaging gap). Run via
// `python -c <this> <control-socket-path> <host-pid>`.
//
// Protocol (newline-delimited JSON over the unix socket, forkserver is the client):
//   -> { "id": <n>, "connectionPath": "<abs path>" }   spawn request from Node
//   <- { "type": "ready" }                             once, after imports finish
//   <- { "id": <n>, "pid": <pid> }                     fork succeeded
//   <- { "id": <n>, "error": "<message>" }             fork failed
//
// `<host-pid>` is the Node process that spawned this daemon. It lets a shutdown
// tell a graceful host dispose (the host is still our parent and will kill the
// forked kernels itself, so we must not race its namespace snapshot flush) from
// an unclean host death (the host died without us and we are reparented to a
// subreaper, so we reap our forked kernels or they orphan).
export const FORK_SERVER_SCRIPT = String.raw`
import gc
import json
import os
import signal
import socket
import sys
import time

# The Node host's pid, so a shutdown can tell "host still alive, doing its own
# teardown" from "host died, reap the children myself".
_host_pid = None

# Live forked-kernel pids, so a shutdown after an unclean host death can kill
# every one instead of leaving it orphaned. Discarded as each is reaped.
_children = set()

# The control socket path, remembered so a shutdown can unlink it and its /tmp
# directory (the host's own rmSync never runs when the host is SIGKILLed).
_control_path = None


def _remove_control_path():
    if _control_path is None:
        return
    try:
        os.unlink(_control_path)
    except OSError:
        pass
    try:
        os.rmdir(os.path.dirname(_control_path))
    except OSError:
        pass


def _shutdown():
    # Only reap the forked kernels when the host died without us: a live host is
    # mid-teardown and will dispose each kernel itself (its namespace snapshot may
    # still be flushing, so killing them here would lose work). On an unclean host
    # death the control socket closes (the host's fd cleanup) just *before* the
    # kernel reparents us to a subreaper/init, so poll briefly for that reparenting
    # to land before reading getppid() — otherwise a graceful dispose is mistaken
    # for a death and the host's own dispose would have already killed the kernels.
    if _host_pid is not None:
        deadline = time.monotonic() + 1.0
        while os.getppid() == _host_pid and time.monotonic() < deadline:
            time.sleep(0.01)
        if os.getppid() != _host_pid:
            for pid in list(_children):
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass
    _remove_control_path()


def _reap_children(*_args):
    # Reap every exited child so disposed kernels never linger as zombies. Wired to
    # SIGCHLD so reaping happens on child exit, not only when the next request wakes
    # the accept loop. Safe under PEP 475: the interrupted socket read auto-retries.
    try:
        while True:
            pid, _status = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                break
            _children.discard(pid)
    except ChildProcessError:
        pass


def _import_template():
    # Everything a kernel touches at import time. Paid once; shared COW by children.
    import IPython  # noqa: F401
    import ipykernel  # noqa: F401
    import ipykernel.kernelapp  # noqa: F401
    import jupyter_client  # noqa: F401
    import nest_asyncio  # noqa: F401
    try:
        import rlm  # noqa: F401
    except Exception:
        # rlm may not import cleanly outside a live kernel namespace; the Node-side
        # bootstrap cell wires it up per-child regardless. Preloading is a best-effort
        # speedup, not a correctness requirement.
        pass


def _run_child(connection_path, cwd, env):
    # We are the forked child; become the ipykernel server on the given connection.
    from ipykernel.kernelapp import IPKernelApp

    # Drop the inherited SIGCHLD reaper so it can't interfere with ipykernel's own
    # child/signal handling.
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)

    # cwd/env are per-kernel and applied here (not at template import), so all
    # kernels can share one warm template regardless of their working dir / env.
    if env:
        os.environ.update(env)
    if cwd:
        # Don't swallow a bad cwd: direct spawn fails fast on ENOENT, so match that
        # (the OSError propagates, the child exits non-zero, Node falls back).
        os.chdir(cwd)

    # Drop any singleton the template happened to build so the child owns a fresh
    # instance (and, critically, a jupyter_client Session created in *this* pid;
    # a Session inherited from the template silently drops messages via check_pid).
    IPKernelApp.clear_instance()
    app = IPKernelApp.instance(connection_file=connection_path)
    # initialize() binds the 5 ZMQ ports, writes the resolved ports back into
    # connection.json, and starts the heartbeat thread + ioloop — all post-fork,
    # so no thread/loop/socket is ever inherited across the fork boundary.
    app.initialize([])
    app.start()


def _serve(control_path, host_pid):
    global _control_path, _host_pid
    _control_path = control_path
    _host_pid = host_pid

    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect(control_path)
        control_fd = sock.fileno()

        # Reap forked kernels as they exit, independent of the request loop.
        signal.signal(signal.SIGCHLD, _reap_children)

        _import_template()
        # Freeze the heap so the cyclic GC doesn't write to (and thus COW-copy) the
        # shared module pages, keeping memory genuinely shared across children.
        gc.freeze()

        f = sock.makefile("rwb", buffering=0)
        f.write(json.dumps({"type": "ready"}).encode() + b"\n")
        f.flush()

        while True:
            # Belt-and-suspenders: the SIGCHLD handler is the primary reaper, but sweep
            # again each turn in case a signal was missed (coalesced) while handling one.
            _reap_children()

            line = f.readline()
            if not line:
                break
            try:
                req = json.loads(line)
            except ValueError:
                continue
            req_id = req.get("id")
            connection_path = req.get("connectionPath")
            cwd = req.get("cwd")
            env = req.get("env")

            try:
                pid = os.fork()
            except OSError as exc:
                f.write(json.dumps({"id": req_id, "error": str(exc)}).encode() + b"\n")
                f.flush()
                continue

            if pid == 0:
                # Child: shed every inherited fd tied to the control channel, then run.
                try:
                    sock.close()
                    f.close()
                except Exception:
                    pass
                try:
                    os.close(control_fd)
                except OSError:
                    pass
                try:
                    _run_child(connection_path, cwd, env)
                except BaseException as exc:  # never return to the accept loop
                    sys.stderr.write("forked kernel failed: %r\n" % (exc,))
                    os._exit(1)
                os._exit(0)

            # Parent: stay pristine (no loop/threads/ZMQ ever) so the next fork is
            # clean. Track the child so a shutdown can kill it, then reply.
            _children.add(pid)
            f.write(json.dumps({"id": req_id, "pid": pid}).encode() + b"\n")
            f.flush()
    finally:
        # Host went away (socket EOF) or the daemon failed mid-flight: reap forked
        # kernels if the host is gone, and always drop the socket dir so nothing
        # lingers in /tmp after an unclean host death.
        _shutdown()


if __name__ == "__main__":
    _serve(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else None)
`;

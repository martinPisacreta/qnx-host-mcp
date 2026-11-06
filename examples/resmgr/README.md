# QNX 8.0 resource manager example

This single-process C example exposes `/dev/automata-echo` as a QNX resource manager.
A server thread handles requests; the main thread acts as an ordinary POSIX client.

## Status

Compiled through QNX Host MCP (`node scripts/compile-example.mjs examples/resmgr src/resmgr.c`) and run on QNX 8.0 in QEMU on 6 November 2026; a direct `qcc -Vgcc_ntox86_64` build also succeeds without warnings.
The output matched [expected-output.txt](expected-output.txt) and the process exited with status 0.
Evidence: [evidence/qemu-run-resmgr-20261106](../../evidence/qemu-run-resmgr-20261106/README.md).

## Why `_RESMGR_FLAG_SELF`

By default, QNX does not resolve a pathname back to the process that registered it.
The first run of this example failed with `ENOENT` on `open` and `stat`, although `resmgr_attach` had succeeded.
`resmgr_attach` is therefore called with `_RESMGR_FLAG_SELF` ("Allow resolving names to itself" in `sys/resmgr.h`).
The default protects single-threaded managers: a process that sends to its own channel with no thread free to receive would block forever.
This example is safe because a separate server thread receives and replies while the main thread waits.

## Server

`dispatch_create` creates the dispatch interface.
`iofunc_func_init` supplies the default connection and I/O handlers.
`iofunc_attr_init` initializes a read-only character-device attribute.
`resmgr_attach` registers the path with a custom `io_read` handler.
`dispatch_context_alloc` allocates the context used by the server loop.
The loop calls `dispatch_block` followed by `dispatch_handler`.

## Reads and offsets

The handler first calls `iofunc_read_verify`.
It supports ordinary reads and rejects extended read types.
Each reply is limited by the requested size and the remaining payload.
The open control block's offset advances by the number of bytes returned.
At the end of the payload, the handler returns zero bytes.
The payload contains 33 ASCII bytes, without a newline or terminating NUL.

## Client and lifetime

The client waits for server readiness and checks that the path exists.
Startup polling uses at most 500 intervals of 10 milliseconds.
It opens the path, reads in chunks of at most seven bytes, and checks EOF.
It verifies the complete payload before printing the two expected lines.
Returning from `main` terminates the server thread and its registration.
This is a self-contained demonstration, not a persistent device service.

## Build and run

Compile with the same command used in the [tutorial](../../tutorial/README.md):

```bash
source /root/qnx800/qnxsdp-env.sh
qcc -Vgcc_ntox86_64 -o automata-resmgr src/resmgr.c
```

Add the binary to the tutorial image with `[perms=0755] automata-resmgr=<path>` in `local/snippets/ifs_files.custom`, run `/proc/boot/automata-resmgr` from `local/snippets/post_start.custom`, rebuild with `mkqnximage --noprompt --build`, and boot it as in the tutorial.
Failures print a diagnostic to stderr and terminate the process unsuccessfully.

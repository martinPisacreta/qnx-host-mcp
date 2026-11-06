# QNX resource manager: compilation and guest execution (2026-11-06)

This directory records the third example, [examples/resmgr](../../examples/resmgr/README.md), compiled with the QNX SDP 8.0 compiler and run inside a QNX 8.0 x86_64 guest in QEMU on the project host (Ubuntu 24.04 on WSL2, QEMU 8.2.2 from the Ubuntu archive). Details are in [host-and-image.txt](host-and-image.txt).

## Compilation

Like the msgpass example, the source was compiled through QNX Host MCP: `node scripts/compile-example.mjs examples/resmgr src/resmgr.c` launched the MCP server over stdio, called `qnx_compile_c` with `src/resmgr.c` and polled `qnx_operation_status`. The result is in [mcp-compile-result.json](mcp-compile-result.json): state `succeeded`, exit code 0, a 14344-byte artifact, re-hashed by the client. A direct `qcc -Vgcc_ntox86_64 -Wall` build of the same source also returned 0 with no warnings. The source and MCP artifact hashes are in [sha256.txt](sha256.txt).

## Guest execution

The unchanged MCP artifact was placed at `/proc/boot/automata-resmgr` by [ifs_files.custom](ifs_files.custom) in the custom image of the [tutorial](../../tutorial/README.md), and [post_start.custom](post_start.custom) ran it at the end of startup, after the hello and message-passing examples in the same boot.

From [qemu-serial-console.txt](qemu-serial-console.txt):

```
QNX_RESMGR_RUN_BEGIN
resmgr: read 33 bytes: hello from a QNX resource manager
resmgr: ok
QNX_RESMGR_RUN_EXIT=0
```

The two program lines match [expected-output.txt](../../examples/resmgr/expected-output.txt) exactly. The server thread registered `/dev/automata-echo` with `resmgr_attach`, and the main thread opened it and read the 33-byte payload in chunks of at most seven bytes through the custom `io_read` handler.

## First attempt

The first build, without `_RESMGR_FLAG_SELF`, compiled but failed in the guest with `resmgr: wait for /dev/automata-echo failed: errno=260`. An instrumented copy showed that `resmgr_attach` succeeded while `stat` and `open` on the path returned `ENOENT`, because QNX does not resolve a pathname back to the process that registered it unless the manager passes `_RESMGR_FLAG_SELF`. Adding that flag fixed the run; the example's README explains why the default exists.

## Limits

- The guest had no network interface; the image's networking and sshd startup messages in the console are unrelated to the example.
- No login was performed. The run relies only on the startup snippet.
- This is a demonstration of the resource manager API, not a persistent device service or a timing measurement.

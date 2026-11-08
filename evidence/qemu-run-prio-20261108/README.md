# QNX message priority inheritance: compilation and guest execution (2026-11-08)

This directory records the sixth example, [examples/prioinherit](../../examples/prioinherit/README.md), compiled with the QNX SDP 8.0 compiler and run inside a QNX 8.0 x86_64 guest in QEMU on the project host (Ubuntu 24.04 on WSL2, QEMU 8.2.2 from the Ubuntu archive). Details are in [host-and-image.txt](host-and-image.txt).

## Compilation

The source was compiled through QNX Host MCP: `node scripts/compile-example.mjs examples/prioinherit src/prioinherit.c` launched the MCP server over stdio, called `qnx_compile_c` with `src/prioinherit.c` and polled `qnx_operation_status`. The result is in [mcp-compile-result.json](mcp-compile-result.json): state `succeeded`, exit code 0, an 18560-byte artifact, re-hashed by the client. A direct `qcc -Vgcc_ntox86_64 -Wall` build of the same source also returned 0 with no warnings and produced a byte-identical binary (same SHA-256). The source and binary hashes are in [sha256.txt](sha256.txt).

## Guest execution

The direct build, byte-identical to the MCP artifact, was placed at `/proc/boot/automata-prio` by [ifs_files.custom](ifs_files.custom) in the custom image of the [tutorial](../../tutorial/README.md), and [post_start.custom](post_start.custom) ran it at the end of startup, after the hello, message-passing, resource-manager, pulses and registered-events examples in the same boot. All six examples exited with status 0 in that boot.

From [qemu-serial-console.txt](qemu-serial-console.txt):

```
QNX_PRIO_RUN_BEGIN
QNX_PRIO_INHERIT_OK received_at=12,20
QNX_PRIO_FIXED_OK received_at=10,10
QNX_PRIO_RUN_EXIT=0
```

The two program lines match [expected-output.txt](../../examples/prioinherit/expected-output.txt) exactly. Both server threads were created at priority 10 with `SCHED_RR`. On the ordinary channel, the server reported a current priority (`sched_curpriority` from `SchedGet`) of 12 and then 20 while handling messages from clients running at those priorities. On the channel created with `_NTO_CHF_FIXED_PRIORITY`, the server reported 10 for both clients.

## Limits

- The guest had no network interface; the networking and sshd startup messages of the image in the console are unrelated to the example.
- No login was performed. The run relies only on the startup snippet.
- Clients and servers are threads of one process. The run shows the priority the receiving thread reported on QNX 8.0; it does not test inheritance across processes, and it does not measure scheduling latency, which QEMU with TCG cannot represent.

# QNX name service between two processes: compilation and guest execution (2026-11-09)

This directory records the seventh example, [examples/nameservice](../../examples/nameservice/README.md), compiled with the QNX SDP 8.0 compiler and run inside a QNX 8.0 x86_64 guest in QEMU on the project host (Ubuntu 24.04 on WSL2, QEMU 8.2.2 from the Ubuntu archive). Details are in [host-and-image.txt](host-and-image.txt).

## Compilation

The source was compiled through QNX Host MCP: `node scripts/compile-example.mjs examples/nameservice src/nameservice.c` launched the MCP server over stdio, called `qnx_compile_c` with `src/nameservice.c` and polled `qnx_operation_status`. The result is in [mcp-compile-result.json](mcp-compile-result.json): state `succeeded`, exit code 0, a 14224-byte artifact, re-hashed by the client. A direct `qcc -Vgcc_ntox86_64 -Wall` build of the same source also returned 0 with no warnings and produced a byte-identical binary (same SHA-256). The source and binary hashes are in [sha256.txt](sha256.txt).

## Guest execution

The direct build, byte-identical to the MCP artifact, was placed at `/proc/boot/automata-name` by [ifs_files.custom](ifs_files.custom) in the custom image of the [tutorial](../../tutorial/README.md), and [post_start.custom](post_start.custom) ran it at the end of startup, after the six earlier examples in the same boot. All seven examples exited with status 0 in that boot.

From [qemu-serial-console.txt](qemu-serial-console.txt):

```
QNX_NAME_RUN_BEGIN
QNX_NAME_OK replies=21,33,63
cross_process=1 registered=1
QNX_NAME_RUN_EXIT=0
```

The two program lines match [expected-output.txt](../../examples/nameservice/expected-output.txt) exactly. The server registered `automata-name` with `name_attach` and found it under `/dev/name/local`; the forked child opened it with `name_open`, and the server acknowledged the `_IO_CONNECT` message, replied to the three requests with 21, 33 and 63, and saw a sender process ID different from its own for each of them.

## Limits

- The guest had no network interface; the networking and sshd startup messages of the image in the console are unrelated to the example.
- No login was performed. The run relies only on the startup snippet.
- The name is local to the guest. The run does not test global names across QNX nodes, and client and server come from one executable split with `fork`.

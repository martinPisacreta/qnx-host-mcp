# QNX native message passing: MCP compilation and guest execution (2026-11-04)

This directory records the second example, [examples/msgpass](../../examples/msgpass/README.md), compiled through QNX Host MCP and run inside a QNX SDP 8.0 x86_64 guest in QEMU on the project host (Ubuntu 24.04 on WSL2, QEMU 8.2.2 from the Ubuntu archive).

## Compilation through MCP

`node scripts/compile-example.mjs examples/msgpass src/msgpass.c` launched the MCP server over stdio, called `qnx_compile_c` with `src/msgpass.c` and polled `qnx_operation_status`. The result is in [mcp-compile-result.json](mcp-compile-result.json): state `succeeded`, exit code 0, a 13992-byte artifact with SHA-256 `1e928f1699eb8ecf7b40850043347a31eaeb313c26f3fd9945bb8dc6c71901e0`, re-hashed by the client. The file type is an x86-64 ELF using the QNX loader `/usr/lib/ldqnx-64.so.2`.

## Guest execution

The same image workflow as [qemu-run-20261103](../qemu-run-20261103/README.md) was used: an image built with the SDK's `mkqnximage`, the unchanged artifact placed at `/proc/boot/automata-msgpass` by [ifs_files.custom](ifs_files.custom), and [post_start.custom](post_start.custom) running it at the end of startup. The guest also re-ran the hello example in the same boot. Hashes are in [sha256.txt](sha256.txt).

From [qemu-serial-console.txt](qemu-serial-console.txt):

```
QNX_MSGPASS_RUN_BEGIN
msgpass: sent 7 got 14
msgpass: sent 11 got 22
msgpass: sent 21 got 42
msgpass: ok
QNX_MSGPASS_RUN_EXIT=0
```

The four program lines match [expected-output.txt](../../examples/msgpass/expected-output.txt) exactly. The program exchanged three synchronous messages between two threads through `ChannelCreate`, `ConnectAttach`, `MsgSend`, `MsgReceive` and `MsgReply`, and exited with status 0.

## Limits

- The guest had no network interface; the image's networking and sshd startup messages in the console are unrelated to the example.
- The artifact was placed in the image by the SDK image tools, not by the MCP server. The MCP image lifecycle tools remain blocked.
- No login was performed. The run relies only on the startup snippet.

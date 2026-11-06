# QNX pulses and timers: compilation and guest execution (2026-11-06)

This directory records the fourth example, [examples/pulses](../../examples/pulses/README.md), compiled with the QNX SDP 8.0 compiler and run inside a QNX 8.0 x86_64 guest in QEMU on the project host (Ubuntu 24.04 on WSL2, QEMU 8.2.2 from the Ubuntu archive). Details are in [host-and-image.txt](host-and-image.txt).

## Compilation

The source was compiled through QNX Host MCP: `node scripts/compile-example.mjs examples/pulses src/pulses.c` launched the MCP server over stdio, called `qnx_compile_c` with `src/pulses.c` and polled `qnx_operation_status`. The result is in [mcp-compile-result.json](mcp-compile-result.json): state `succeeded`, exit code 0, a 13896-byte artifact, re-hashed by the client. A direct `qcc -Vgcc_ntox86_64 -Wall` build of the same source also returned 0 with no warnings. The source and MCP artifact hashes are in [sha256.txt](sha256.txt).

## Guest execution

The unchanged MCP artifact was placed at `/proc/boot/automata-pulses` by [ifs_files.custom](ifs_files.custom) in the custom image of the [tutorial](../../tutorial/README.md), and [post_start.custom](post_start.custom) ran it at the end of startup, after the hello, message-passing and resource-manager examples in the same boot. All four examples exited with status 0 in that boot.

From [qemu-serial-console.txt](qemu-serial-console.txt):

```
QNX_PULSES_RUN_BEGIN
QNX_PULSES_OK received=5
elapsed_ms_ok=1
QNX_PULSES_RUN_EXIT=0
```

The two program lines match [expected-output.txt](../../examples/pulses/expected-output.txt) exactly: a `CLOCK_MONOTONIC` timer armed with a 100 ms interval delivered five pulses with code `_PULSE_CODE_MINAVAIL` and value 42 to the process's own channel, and they arrived within the example's 400 to 1500 ms tolerance.

## Limits

- The guest had no network interface; the image's networking and sshd startup messages in the console are unrelated to the example.
- No login was performed. The run relies only on the startup snippet.
- QEMU ran with TCG emulation (`-cpu max`), so the elapsed-time check is a tolerance for a demonstration, not a timing or real-time measurement. The program prints only whether the tolerance was met, not the elapsed milliseconds.

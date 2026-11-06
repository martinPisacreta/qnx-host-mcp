# QNX registered events: compilation and guest execution (2026-11-06)

This directory records the fifth example, [examples/events](../../examples/events/README.md), compiled with the QNX SDP 8.0 compiler and run inside a QNX 8.0 x86_64 guest in QEMU on the project host (Ubuntu 24.04 on WSL2, QEMU 8.2.2 from the Ubuntu archive). Details are in [host-and-image.txt](host-and-image.txt).

## Compilation

The source was compiled through QNX Host MCP: `node scripts/compile-example.mjs examples/events src/events.c` launched the MCP server over stdio, called `qnx_compile_c` with `src/events.c` and polled `qnx_operation_status`. The result is in [mcp-compile-result.json](mcp-compile-result.json): state `succeeded`, exit code 0, a 14208-byte artifact, re-hashed by the client. A direct `qcc -Vgcc_ntox86_64 -Wall` build of the same source also returned 0 with no warnings. The source and MCP artifact hashes are in [sha256.txt](sha256.txt).

## Guest execution

The unchanged MCP artifact was placed at `/proc/boot/automata-events` by [ifs_files.custom](ifs_files.custom) in the custom image of the [tutorial](../../tutorial/README.md), and [post_start.custom](post_start.custom) ran it at the end of startup, after the hello, message-passing, resource-manager and pulses examples in the same boot. All five examples exited with status 0 in that boot.

From [qemu-serial-console.txt](qemu-serial-console.txt):

```
QNX_EVENTS_RUN_BEGIN
QNX_EVENTS_OK delivered=3
registered=1 verified=1
QNX_EVENTS_RUN_EXIT=0
```

The two program lines match [expected-output.txt](../../examples/events/expected-output.txt) exactly: the client registered a pulse event with `MsgRegisterEvent`, the server replied, `MsgVerifyEvent` accepted the event, and three `MsgDeliverEvent` calls delivered pulses with code `_PULSE_CODE_MINAVAIL` and value 7 to the notification channel of the client.

## Limits

- The guest had no network interface; the networking and sshd startup messages of the image in the console are unrelated to the example.
- No login was performed. The run relies only on the startup snippet.
- Client and server are two threads of one process. The run shows registration, verification and delivery working on QNX 8.0; it does not test delivery of an unregistered event or delivery across processes.

# QNX 8.0 message priority inheritance example

This single-process C example shows that a QNX server thread receiving a message runs at the priority of the client that sent it, and that a channel created with `_NTO_CHF_FIXED_PRIORITY` turns that off.

## Status

Compiled through QNX Host MCP (`node scripts/compile-example.mjs examples/prioinherit src/prioinherit.c`) and run on QNX 8.0 in QEMU on 8 November 2026; a direct `qcc -Vgcc_ntox86_64 -Wall` build of the same source also succeeds without warnings and produces the same binary.
The output matched [expected-output.txt](expected-output.txt) and the process exited with status 0.
Evidence: [evidence/qemu-run-prio-20261108](../../evidence/qemu-run-prio-20261108/README.md).

## What it does

The main thread creates two channels: an ordinary one with `ChannelCreate(0)` and one with `ChannelCreate(_NTO_CHF_FIXED_PRIORITY)`.
It starts one server thread per channel, both with explicit `SCHED_RR` scheduling at priority 10, so the priority left over from one channel cannot affect the other.
Each server receives two messages; after each `MsgReceive` it calls `SchedGet(0, 0, &param)` and replies with `param.sched_curpriority`.
For each channel in turn, the main thread starts one client thread at priority 12 and, after it finishes, another at priority 20; each client connects with `ConnectAttach(..., _NTO_SIDE_CHANNEL, 0)`, sends one message with `MsgSend` and keeps the priority the server replied.
It uses only libc (on QNX the pthread functions are in libc), so it compiles through MCP, which passes no extra libraries.

## Output and exit status

If the ordinary channel reported 12 and 20 and the fixed-priority channel reported 10 and 10, it prints the two lines of [expected-output.txt](expected-output.txt) and exits with status 0.
If the observed priorities differ, it prints them to stderr and exits with status 1; a failed call prints its name and error description to stderr and exits with status 1.

## Build and run

```bash
source /root/qnx800/qnxsdp-env.sh
qcc -Vgcc_ntox86_64 -Wall -o automata-prio src/prioinherit.c
```

Add the binary to the tutorial image with `[perms=0755] automata-prio=<path>` in `local/snippets/ifs_files.custom`, run `/proc/boot/automata-prio` from `local/snippets/post_start.custom`, rebuild with `mkqnximage --noprompt --build`, and boot it as in the [tutorial](../../tutorial/README.md). [Part 6](../../tutorial/part6-priority-inheritance.md) walks through the code.

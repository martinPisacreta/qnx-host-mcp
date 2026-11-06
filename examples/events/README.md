# QNX 8.0 registered events example

This single-process C example shows the QNX "reply now, notify later" pattern: a client registers a pulse event with `MsgRegisterEvent`, sends it to a server thread, and the server replies at once and later delivers it with `MsgDeliverEvent`.

## Status

Compiled through QNX Host MCP (`node scripts/compile-example.mjs examples/events src/events.c`) and run on QNX 8.0 in QEMU on 6 November 2026; a direct `qcc -Vgcc_ntox86_64 -Wall` build of the same source also succeeds without warnings.
The output matched [expected-output.txt](expected-output.txt) and the process exited with status 0.
Evidence: [evidence/qemu-run-events-20261106](../../evidence/qemu-run-events-20261106/README.md).

## What it does

The main thread creates a notification channel and a side-channel connection to it, and starts a server thread.
The server thread creates its own channel and passes its ID to the main thread in a startup message, so neither side polls.
The client builds a pulse event with `SIGEV_PULSE_INIT` (code `_PULSE_CODE_MINAVAIL`, value 7), registers it for the server connection with `MsgRegisterEvent`, and sends it with `MsgSend`.
The server replies immediately, checks the event with `MsgVerifyEvent`, waits 50 ms, and delivers it three times with `MsgDeliverEvent`.
The client receives the three pulses with `MsgReceivePulse`, checks code and value, calls `MsgUnregisterEvent`, joins the thread and releases its connections and channels.
It uses only libc (on QNX the pthread functions are in libc), so it compiles through MCP, which passes no extra libraries.

## Output and exit status

On success it prints the two lines of [expected-output.txt](expected-output.txt) and exits with status 0.
A failed call prints its name and error description to stderr and exits with status 1; a failure in either thread ends the whole process so the other thread cannot stay blocked.

## Build and run

```bash
source /root/qnx800/qnxsdp-env.sh
qcc -Vgcc_ntox86_64 -Wall -o automata-events src/events.c
```

Add the binary to the tutorial image with `[perms=0755] automata-events=<path>` in `local/snippets/ifs_files.custom`, run `/proc/boot/automata-events` from `local/snippets/post_start.custom`, rebuild with `mkqnximage --noprompt --build`, and boot it as in the [tutorial](../../tutorial/README.md). [Part 5](../../tutorial/part5-registered-events.md) walks through the code.

# QNX 8.0 name service example: a client in another process finds the server by name

This C example registers a server under a name with `name_attach`; a child process created with `fork` finds it with `name_open` and exchanges three messages with `MsgSend`. It is native QNX message passing between two processes, the way services find each other in a QNX system.

## Status

Compiled through QNX Host MCP (`node scripts/compile-example.mjs examples/nameservice src/nameservice.c`) and run on QNX 8.0 in QEMU on 9 November 2026; a direct `qcc -Vgcc_ntox86_64 -Wall` build of the same source also succeeds without warnings and produces the same binary.
The output matched [expected-output.txt](expected-output.txt) and the process exited with status 0.
Evidence: [evidence/qemu-run-name-20261109](../../evidence/qemu-run-name-20261109/README.md).

## What it does

The parent calls `name_attach(NULL, "automata-name", 0)`, checks that `/dev/name/local/automata-name` exists and then calls `fork`.
The child retries `name_open("automata-name", 0)` up to 50 times, sends the values 7, 11 and 21 with `MsgSend`, checks that the replies are 21, 33 and 63, closes the connection with `name_close` and exits.
The parent receives on `attach->chid`: it replies `EOK` to the `_IO_CONNECT` message that `name_open` sends, rejects other I/O message types with `ENOSYS`, detaches on `_PULSE_CODE_DISCONNECT`, and answers each data message with three times its value after checking in the `struct _msg_info` filled by `MsgReceive` that the sender's process ID is not its own.
It then waits for the child and removes the name with `name_detach`. It uses only libc, so it compiles through MCP, which passes no extra libraries.

## Output and exit status

If the child exited with 0, the three replies were 21, 33 and 63, all three requests came from another process and the name was registered, it prints the two lines of [expected-output.txt](expected-output.txt) and exits with status 0.
Otherwise it prints the observed values to stderr and exits with status 1; a failed call prints its name and error description to stderr and exits with status 1.

## Build and run

```bash
source /root/qnx800/qnxsdp-env.sh
qcc -Vgcc_ntox86_64 -Wall -o automata-name src/nameservice.c
```

Add the binary to the tutorial image with `[perms=0755] automata-name=<path>` in `local/snippets/ifs_files.custom`, run `/proc/boot/automata-name` from `local/snippets/post_start.custom`, rebuild with `mkqnximage --noprompt --build`, and boot it as in the [tutorial](../../tutorial/README.md). [Part 7](../../tutorial/part7-name-service.md) walks through the code.

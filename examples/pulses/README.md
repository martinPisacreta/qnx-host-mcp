# QNX 8.0 pulses and timers example

This single-process C example arms a periodic POSIX timer that delivers QNX pulses to the process's own channel, and receives five of them with `MsgReceivePulse`.

## Status

Compiled through QNX Host MCP (`node scripts/compile-example.mjs examples/pulses src/pulses.c`) and run on QNX 8.0 in QEMU on 6 November 2026; a direct `qcc -Vgcc_ntox86_64 -Wall` build of the same source also succeeds without warnings.
The output matched [expected-output.txt](expected-output.txt) and the process exited with status 0.
Evidence: [evidence/qemu-run-pulses-20261106](../../evidence/qemu-run-pulses-20261106/README.md).

## What it does

`ChannelCreate` creates a channel and `ConnectAttach` with `_NTO_SIDE_CHANNEL` attaches a connection to it in the same process.
`SIGEV_PULSE_INIT` describes a pulse with code `_PULSE_CODE_MINAVAIL` and value 42, sent on that connection.
`timer_create(CLOCK_MONOTONIC, ...)` binds the event to a timer, and `timer_settime` arms it with a 100 ms first expiration and a 100 ms interval.
The loop calls `MsgReceivePulse` and checks the code and `value.sival_int` of each pulse; there is no `MsgReply`, because pulses are not replied to.
After five pulses the program measures the elapsed `CLOCK_MONOTONIC` time, then deletes the timer, detaches the connection and destroys the channel.

## Output and exit status

On success it prints the two lines of [expected-output.txt](expected-output.txt) and exits with status 0.
`elapsed_ms_ok=1` means the five pulses arrived within 400 to 1500 ms (nominally about 500 ms). This is a demonstration tolerance, not a real-time measurement: the recorded guest ran under QEMU's TCG emulation.
A failed call prints its name and `strerror(errno)` to stderr and exits with status 1; an unexpected pulse code or value is reported as `EPROTO`; a duration outside the tolerance prints `elapsed_ms_ok=0` and exits with status 1.

## Build and run

```bash
source /root/qnx800/qnxsdp-env.sh
qcc -Vgcc_ntox86_64 -Wall -o automata-pulses src/pulses.c
```

Add the binary to the tutorial image with `[perms=0755] automata-pulses=<path>` in `local/snippets/ifs_files.custom`, run `/proc/boot/automata-pulses` from `local/snippets/post_start.custom`, rebuild with `mkqnximage --noprompt --build`, and boot it as in the [tutorial](../../tutorial/README.md). [Part 4](../../tutorial/part4-pulses-timers.md) walks through the code.

# Part 4: Native QNX pulses and timers

Continue from [Part 3](part3-resource-manager.md): a periodic timer that notifies a receiver through its channel, in one process.
This chapter uses [`examples/pulses/src/pulses.c`](../examples/pulses/src/pulses.c), its [README](../examples/pulses/README.md) and the run recorded in [`evidence/qemu-run-pulses-20261106/`](../evidence/qemu-run-pulses-20261106/README.md).
Line numbers below refer to that 100-line source; the recorded guest run took place on 6 November 2026.

## Receive asynchronous notifications

A pulse is a small asynchronous notification delivered to a QNX channel.
It carries a code and a value, and the receiver does not call `MsgReply` for it.
Unlike Part 2's synchronous requests, a timer notification needs no sender waiting for a reply.
QNX timers can deliver signals or pulses; this example chooses pulses so the notifications are handled in the channel's receive loop, in ordinary control flow, without a signal handler.

## Create the channel and connection

Lines 31 and 36 create the channel and attach a side-channel connection to it in the same process:
```c
chid = ChannelCreate(0);
coid = ConnectAttach(0, 0, chid, _NTO_SIDE_CHANNEL, 0);
```
Each call is followed by an error check. The connection tells the timer where to deliver its pulses.

## Configure and arm the timer

Line 41 describes the event with an application pulse code and a fixed value:
```c
SIGEV_PULSE_INIT(&ev, coid, SIGEV_PULSE_PRIO_INHERIT,
                 _PULSE_CODE_MINAVAIL, pulse_value);
```
`pulse_value` is 42, and the receiver checks both this value and the code.
Line 43 associates the event with a `CLOCK_MONOTONIC` timer through `timer_create`.
Lines 48 and 49 set `it_value` and `it_interval` to 100000000 ns with zero seconds, so the first expiration and the repeating interval are both 100 ms.
The program records its start time (line 50) immediately before arming the timer with `timer_settime` (line 54).

## Receive five pulses and release resources

`MsgReceivePulse` (line 60) blocks until a pulse arrives and fills a `struct _pulse`.
Line 64 checks its `code` and `value.sival_int`; the loop then counts the pulse.
After five accepted pulses, a second `CLOCK_MONOTONIC` timestamp (line 72) ends the measurement.
The nominal duration is about 500 ms, and line 78 accepts 400 through 1500 ms, inclusive.
This is a demonstration tolerance, not a scheduling guarantee or a real-time benchmark: the recorded guest ran under QEMU's TCG emulation, and the example does not analyze timer overruns.
Cleanup (lines 82 to 91) deletes the timer, detaches the connection and destroys the channel, in that order.
A failed call prints its name and `strerror(errno)` to stderr and exits with status 1. An unexpected code or value is reported with `EPROTO`, and an out-of-range duration prints `elapsed_ms_ok=0` and exits with status 1.

## Compile for the tutorial image

In the SDK shell from Part 1, with `pulses.c` copied to `/root/qnx-tutorial-src`:
```bash
cd /root/qnx-tutorial-src
source /root/qnx800/qnxsdp-env.sh
qcc -Vgcc_ntox86_64 -Wall -o automata-pulses pulses.c
cp automata-pulses /root/qnx-tutorial-run/automata-pulses
```
The recorded run used the artifact compiled through QNX Host MCP (`node scripts/compile-example.mjs examples/pulses src/pulses.c`); the direct `qcc -Wall` build above also returned 0 with no warnings.

## Add it to the image

Keep the earlier mappings and append this entry to `local/snippets/ifs_files.custom`:
```text
[perms=0755] automata-pulses=/root/qnx-tutorial-run/automata-pulses
```
Append this block to `local/snippets/post_start.custom`, after the earlier examples:
```sh
echo "QNX_PULSES_RUN_BEGIN"
/proc/boot/automata-pulses
echo "QNX_PULSES_RUN_EXIT=$?"
```
From `/root/qnx-tutorial-run`, rebuild with `mkqnximage --noprompt --build`.
Boot as in Part 1 and change the launcher's wait marker to `QNX_PULSES_RUN_EXIT`, keeping its early-exit check.
The recorded snippets are [`ifs_files.custom`](../evidence/qemu-run-pulses-20261106/ifs_files.custom) and [`post_start.custom`](../evidence/qemu-run-pulses-20261106/post_start.custom).

## Recorded output and common problems

The saved [`qemu-serial-console.txt`](../evidence/qemu-run-pulses-20261106/qemu-serial-console.txt) contains:
```text
QNX_PULSES_RUN_BEGIN
QNX_PULSES_OK received=5
elapsed_ms_ok=1
QNX_PULSES_RUN_EXIT=0
```
The two program lines match [`examples/pulses/expected-output.txt`](../examples/pulses/expected-output.txt); the exit marker records successful execution. The hello, message-passing and resource-manager examples also exited with status 0 in the same boot.
If compilation fails, check that the SDK environment is loaded and keep the compiler diagnostics.
If only the earlier examples appear, check the image mapping, the startup block and the launcher's wait marker.
A timing failure (`elapsed_ms_ok=0`) needs the guest output and the host load preserved for investigation; the example does not print the elapsed milliseconds.
The recorded guest had no network interface; networking and sshd startup messages are unrelated.

Back to [Part 1](README.md), [Part 2](part2-message-passing.md) or [Part 3](part3-resource-manager.md). Next: [Part 5](part5-registered-events.md), registered events in the same image.

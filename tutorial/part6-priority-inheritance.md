# Part 6: Native QNX message priority inheritance

Continue from [Part 5](part5-registered-events.md): this example examines the server priority while handling a synchronous message.
This chapter uses [`examples/prioinherit/src/prioinherit.c`](../examples/prioinherit/src/prioinherit.c), its [expected output](../examples/prioinherit/expected-output.txt) and the run recorded in [`evidence/qemu-run-prio-20261108/`](../evidence/qemu-run-prio-20261108/README.md).
The recorded guest run took place on 8 November 2026.

## Why the client's priority matters

A client calling `MsgSend` waits for a reply from the server.
If a high-priority client depends on a low-priority server, unrelated medium-priority work can delay that server.
This dependency creates an opportunity for priority inversion between processes.
QNX message passing lets a receiving server thread inherit the sending client's priority.
The server can therefore perform the requested work at the priority of the client waiting for it.
This mechanism addresses the message dependency; it does not remove every possible source of priority inversion.
The example uses threads in one process to demonstrate the same native message mechanism.

## Compare two independent servers

Server A receives through a channel created with `ChannelCreate(0)`.
Server B receives through a channel created with `ChannelCreate(_NTO_CHF_FIXED_PRIORITY)`.
Both server threads start with explicit `SCHED_RR` scheduling and assigned priority 10.
The fixed-priority flag prevents the normal message-driven priority change for server B.
Separate server threads keep priority changes in one experiment from carrying into the other.
No sleeps or timing measurements are needed to establish the requested comparison.

## Create explicit scheduling attributes

Use `PTHREAD_EXPLICIT_SCHED` so each new thread uses its configured scheduling attributes.
Set the policy to `SCHED_RR` and supply the requested priority through `pthread_attr_setschedparam`.
Check the supported range using `sched_get_priority_min` and `sched_get_priority_max`.
The servers require priority 10; the clients require priorities 12 and 20.
A scheduling or permission error must fail the demonstration rather than silently substitute another priority.
Pthread functions return error numbers directly; report those numbers with `strerror`.

## Receive, inspect and reply

Each server receives two requests with `MsgReceive`.
Immediately after each successful message receive, it calls `SchedGet(0, 0, &param)`.
The zero process and thread arguments select the calling thread.
Read `param.sched_curpriority`, the current priority, rather than `param.sched_priority`, the assigned priority.
Return the observed integer with `MsgReply` so the client records what the server actually measured.
The successful receive, priority query and reply form the observation; output is not a substitute for this query.

## Run clients one at a time

Each client connects with `ConnectAttach(0, 0, chid, _NTO_SIDE_CHANNEL, 0)`.
It sends a request with `MsgSend`, stores the returned priority and detaches its connection.
The main thread joins each client before starting the next one.
First send clients at priorities 12 and 20 to A, then clients at priorities 12 and 20 to B.
The expected observations are A: 12,20 and B: 10,10.
Print the success lines only when all four observed values match.
Otherwise report the observed values to stderr and exit with status 1.
Join the server threads and release channel resources before successful completion.

## Compile for the tutorial image

In the SDK shell from Part 1, after copying the source:
```bash
cd /root/qnx-tutorial-src
source /root/qnx800/qnxsdp-env.sh
qcc -Vgcc_ntox86_64 -Wall -o automata-prio prioinherit.c
cp automata-prio /root/qnx-tutorial-run/automata-prio
```
QNX provides the pthread functions in libc; this example requires no additional library flags.
The recorded build used these commands; its result is in the evidence directory.

## Add it to the image

Keep the earlier entries and append this mapping to `local/snippets/ifs_files.custom`:
```text
[perms=0755] automata-prio=/root/qnx-tutorial-run/automata-prio
```
Append the following block to `local/snippets/post_start.custom`:
```sh
echo "QNX_PRIO_RUN_BEGIN"
/proc/boot/automata-prio
echo "QNX_PRIO_RUN_EXIT=$?"
```
From `/root/qnx-tutorial-run`, rebuild with `mkqnximage --noprompt --build`.
Boot as in Part 1, using `QNX_PRIO_RUN_EXIT` as the launcher's wait marker and preserving its early-exit check.
The recorded snippets are [`ifs_files.custom`](../evidence/qemu-run-prio-20261108/ifs_files.custom) and [`post_start.custom`](../evidence/qemu-run-prio-20261108/post_start.custom).

## Recorded output and common problems

The saved [`qemu-serial-console.txt`](../evidence/qemu-run-prio-20261108/qemu-serial-console.txt) contains:
```text
QNX_PRIO_RUN_BEGIN
QNX_PRIO_INHERIT_OK received_at=12,20
QNX_PRIO_FIXED_OK received_at=10,10
QNX_PRIO_RUN_EXIT=0
```
The two program lines match [`examples/prioinherit/expected-output.txt`](../examples/prioinherit/expected-output.txt); the exit marker records successful execution. The five earlier examples also exited with status 0 in the same boot.
The server on the ordinary channel reported the sending client's priority (12, then 20); the server on the `_NTO_CHF_FIXED_PRIORITY` channel kept its own priority 10 for both requests.
If compilation fails, check that the SDK environment is loaded and keep the compiler diagnostics.
If the program exits with status 1, keep the observed priorities it prints on stderr and the failing call name.
If only the earlier examples appear, check the image mapping, the startup block and the launcher's wait marker.
QEMU with TCG is not a real-time timing measurement; this example checks reported scheduling priorities, not latency.
The recorded guest had no network interface; networking and sshd startup messages are unrelated.

Back to [Part 1](README.md), [Part 2](part2-message-passing.md), [Part 3](part3-resource-manager.md), [Part 4](part4-pulses-timers.md) or [Part 5](part5-registered-events.md).

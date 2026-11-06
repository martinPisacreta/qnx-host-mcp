# Part 5: Native QNX registered events

Continue from [Part 4](part4-pulses-timers.md): a client registers a notification event, and a server delivers it after replying.
This chapter uses [`examples/events/src/events.c`](../examples/events/src/events.c), its [README](../examples/events/README.md) and the run recorded in [`evidence/qemu-run-events-20261106/`](../evidence/qemu-run-events-20261106/README.md).
Line numbers below refer to that 190-line source; the recorded guest run took place on 6 November 2026.

## Reply now, notify later

A synchronous request (Part 2) blocks the client in `MsgSend` until the server replies.
If the server held that request open for slow work, the client could do nothing else meanwhile.
The usual QNX pattern is different: the client sends an event describing how it wants to be told, the server replies at once, and later delivers the event with `MsgDeliverEvent`.
Delivery of a pulse does not wait for the client to receive it, so the server never blocks on the client.
QNX 8.0 adds registration: the client registers the event with `MsgRegisterEvent` for a specific server connection before sending it, and the server can check it with `MsgVerifyEvent`.

## Create channels and publish readiness

The main thread creates a notification channel (line 106) and a side-channel connection to it (line 110), then starts the server thread (line 115).
The server thread creates its own channel (line 35) and sends that channel ID to the main thread in a startup message (lines 41 to 56).
The main thread receives and replies to it (lines 121 to 134) and then connects to the server channel (line 135).
This startup handshake avoids polling or an unsynchronized shared variable; it is separate from the notification pattern itself.
Both receive buffers include a `struct _pulse`, and the lengths of the startup and request messages are checked.

## Register the client's event

Line 139 describes the pulse the client wants to receive on its notification connection:
```c
SIGEV_PULSE_INIT(&event, notification_coid, SIGEV_PULSE_PRIO_INHERIT,
                 _PULSE_CODE_MINAVAIL, EVENT_VALUE);
```
`EVENT_VALUE` is 7.
Line 141 registers it with `MsgRegisterEvent(&event, server_coid)`, so the event is tied to the server reached through that connection.
Line 144 sends the registered event to the server with `MsgSend`; the client does not rebuild or modify it afterward.
A client that wants the server to change the value carried by a registered event would mark it with `SIGEV_MAKE_UPDATEABLE` before registering; this example does not.

## Reply, verify and deliver

The server receives the request (line 58), keeps its `rcvid` and copies the event (line 67).
It replies immediately with `MsgReply(rcvid, 0, NULL, 0)` (line 68), which releases the client from `MsgSend`.
`MsgVerifyEvent(rcvid, &event)` (line 71) checks the event for delivery to that client; a failure ends the demonstration instead of attempting delivery.
After a 50 ms `nanosleep` that stands in for later work (lines 75 to 79), it calls `MsgDeliverEvent(rcvid, &event)` three times (lines 80 to 84) and returns.
The `rcvid` stays usable for event delivery after the reply; these calls are not synchronous messages waiting for the client.

## Receive, release and report

The client receives three pulses with `MsgReceivePulse` and checks the code and integer value of each (lines 152 to 162).
It then calls `MsgUnregisterEvent` (line 163), joins the server thread (line 166), detaches both connections and destroys both channels (lines 170 to 181).
Failures print the call name and error description to stderr and exit with status 1; the pthread calls return their error numbers directly to the same helper.
A failure in either thread exits the whole demonstration, so the other thread cannot stay blocked.
On success it prints the two lines of the expected output (lines 182 and 183).

## Compile for the tutorial image

In the SDK shell from Part 1, with `events.c` copied to `/root/qnx-tutorial-src`:
```bash
cd /root/qnx-tutorial-src
source /root/qnx800/qnxsdp-env.sh
qcc -Vgcc_ntox86_64 -Wall -o automata-events events.c
cp automata-events /root/qnx-tutorial-run/automata-events
```
The program needs only libc, which on QNX includes the pthread functions, so it also compiles through QNX Host MCP, which passes fixed arguments and no extra libraries.
The recorded run used the artifact compiled through MCP (`node scripts/compile-example.mjs examples/events src/events.c`); the direct `qcc -Wall` build above also returned 0 with no warnings.

## Add it to the image

Keep the earlier mappings and append this entry to `local/snippets/ifs_files.custom`:
```text
[perms=0755] automata-events=/root/qnx-tutorial-run/automata-events
```
Append this block to `local/snippets/post_start.custom`, after the earlier examples:
```sh
echo "QNX_EVENTS_RUN_BEGIN"
/proc/boot/automata-events
echo "QNX_EVENTS_RUN_EXIT=$?"
```
From `/root/qnx-tutorial-run`, rebuild with `mkqnximage --noprompt --build`.
Boot as in Part 1 and change the launcher's wait marker to `QNX_EVENTS_RUN_EXIT`, keeping its early-exit check.
The recorded snippets are [`ifs_files.custom`](../evidence/qemu-run-events-20261106/ifs_files.custom) and [`post_start.custom`](../evidence/qemu-run-events-20261106/post_start.custom).

## Recorded output and common problems

The saved [`qemu-serial-console.txt`](../evidence/qemu-run-events-20261106/qemu-serial-console.txt) contains:
```text
QNX_EVENTS_RUN_BEGIN
QNX_EVENTS_OK delivered=3
registered=1 verified=1
QNX_EVENTS_RUN_EXIT=0
```
The two program lines match [`examples/events/expected-output.txt`](../examples/events/expected-output.txt); the exit marker records successful execution. The four earlier examples also exited with status 0 in the same boot.
If compilation fails, check that the SDK environment is loaded and keep the compiler diagnostics.
For a registration, verification or delivery failure, keep the exact failing call and the guest diagnostic.
If only the earlier examples appear, check the image mapping, the startup block and the launcher's wait marker.
The recorded guest had no network interface; networking and sshd startup messages are unrelated.

Back to [Part 1](README.md), [Part 2](part2-message-passing.md), [Part 3](part3-resource-manager.md) or [Part 4](part4-pulses-timers.md).

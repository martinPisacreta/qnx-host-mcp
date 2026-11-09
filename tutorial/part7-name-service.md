# Part 7: Find a QNX service by name across processes

Continue from Part 6: move the client and server into separate processes.
The source is [`examples/nameservice/src/nameservice.c`](../examples/nameservice/src/nameservice.c); [`expected-output.txt`](../examples/nameservice/expected-output.txt) contains the expected successful output.
It was compiled directly and through QNX Host MCP and run on QNX 8.0 in QEMU on 9 November 2026; the evidence is in [evidence/qemu-run-name-20261109](../evidence/qemu-run-name-20261109/README.md).

## Why discover a service by name?

A channel ID identifies a channel within its owning process.
Passing only a channel ID to another process does not identify a complete server endpoint.
A named service lets clients discover the endpoint without receiving its process and channel IDs separately.
The client opens a connection by name and uses the returned connection ID with `MsgSend`.
The example uses one executable and `fork`, but the requests cross a process boundary.

## Register before creating the client

The parent calls `name_attach(NULL, "automata-name", 0)` before `fork`.
The returned `name_attach_t` provides the server channel through `attach->chid`.
With these arguments the registration is local to this QNX system.
Its pathname is `/dev/name/local/automata-name`.
The parent checks that pathname using `access` before creating the child.
Registration failures stop the example instead of printing a successful result.

## Open the service from the child

After `fork`, the child calls `name_open("automata-name", 0)`.
It tries at most 50 times, with `usleep(100000)` between unsuccessful attempts.
The parent remains available to receive the connection handshake while the child opens the service.
The child uses the returned connection ID rather than the inherited attachment pointer.
It does not call `name_detach` on the parent's registration.

## Handle connection messages and pulses

The parent calls `MsgReceive` on `attach->chid` and supplies a `struct _msg_info`.
Keep the receive result in `rcvid_t`, which is 64 bits in this SDK.
A zero receive ID identifies a pulse; it must not be passed to `MsgReply`.
For `_PULSE_CODE_DISCONNECT`, release the server connection with `ConnectDetach(pulse.scoid)`.
The example ignores `_PULSE_CODE_UNBLOCK` and `_PULSE_CODE_COIDDEATH`.
An early disconnect fails this demonstration because its sole client has not finished.
`name_open` also sends an `_IO_CONNECT` message that the server must acknowledge.
Reply to that message with `MsgReply(rcvid, EOK, NULL, 0)`.
Reject other types in the `_IO_BASE` through `_IO_MAX` range with `MsgError(rcvid, ENOSYS)`.

## Exchange and validate three requests

Each application request contains a `struct _pulse` header followed by an integer value.
Its header has type zero and subtype zero, distinguishing it from the I/O messages.
The child sends 7, 11 and 21 using three synchronous `MsgSend` calls.
The parent checks the request size, header and expected input before multiplying by three.
Each `MsgReply` returns an integer, producing the expected replies 21, 33 and 63.
The child stores and checks those replies, closes its connection and exits with `_exit`.
For each data message, the parent checks that `info.pid` differs from its own `getpid()`.
After three replies, the parent waits for the child and removes the registration with `name_detach`.
Success requires a successful child exit, all three expected replies and three messages from another PID.
Call failures report the call name and `strerror`; mismatches report observed values to stderr.
This is a finite tutorial protocol; it does not implement a general server or a receive deadline.

## Compile for the tutorial image

In the SDK shell from Part 1, after copying the source:
```bash
cd /root/qnx-tutorial-src
source /root/qnx800/qnxsdp-env.sh
qcc -Vgcc_ntox86_64 -Wall -o automata-name nameservice.c
cp automata-name /root/qnx-tutorial-run/automata-name
```
The example uses libc and needs no additional library flags.
On 9 November 2026 this command returned 0 with no warnings and produced a 14,224-byte binary; the MCP build of the same source produced a byte-identical artifact (same SHA-256).

## Add it to the image

Keep earlier entries and append this mapping to `local/snippets/ifs_files.custom`:
```text
[perms=0755] automata-name=/root/qnx-tutorial-run/automata-name
```
Append this block to `local/snippets/post_start.custom`:
```sh
echo "QNX_NAME_RUN_BEGIN"
/proc/boot/automata-name
echo "QNX_NAME_RUN_EXIT=$?"
```
From `/root/qnx-tutorial-run`, rebuild with `mkqnximage --noprompt --build`.
Boot as in Part 1, using `QNX_NAME_RUN_EXIT` as the launcher's wait marker and preserving its early-exit check.

## Result

The serial console of the 9 November 2026 boot ([qemu-serial-console.txt](../evidence/qemu-run-name-20261109/qemu-serial-console.txt)) shows:
```text
QNX_NAME_RUN_BEGIN
QNX_NAME_OK replies=21,33,63
cross_process=1 registered=1
QNX_NAME_RUN_EXIT=0
```
The two program lines match [`expected-output.txt`](../examples/nameservice/expected-output.txt): the name was registered under `/dev/name/local`, the child process found it with `name_open`, and all three requests came from a process ID different from the server's.
The same boot also ran the examples of Parts 1 to 6 with exit status 0; [`check-run.sh`](check-run.sh) reports `7/7 examples passed` for that console.
If the program exits with status 1, keep the values it prints on stderr and the failing call name.
If only the earlier examples appear, check the image mapping, the startup block and the launcher's wait marker.

## Limits

- The name is local (`/dev/name/local`); the example does not use a global name across QNX nodes.
- Client and server are one executable split with `fork`; they are two processes, but not two separately installed programs.
- The recorded guest had no network interface; networking and sshd startup messages are unrelated.

Back to [Part 1](README.md), [Part 2](part2-message-passing.md), [Part 3](part3-resource-manager.md), [Part 4](part4-pulses-timers.md), [Part 5](part5-registered-events.md) or [Part 6](part6-priority-inheritance.md).

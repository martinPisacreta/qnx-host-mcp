# Part 2: Native QNX synchronous message passing

Continue after Part 1 with a client and server running as two threads in one process.
The example was first compiled through this project's MCP server and run in QEMU on 4 November 2026. Every step below was rerun on 6 November 2026 on the Part 1 image; the console output is in [`verification-part2-2026-11-06.txt`](verification-part2-2026-11-06.txt).

## Send, receive, reply
The client sends a request with `MsgSend`; the server accepts it with `MsgReceive` and answers with `MsgReply`.
The exchange is synchronous: the client waits for the reply before checking the result and sending again.
This makes request completion explicit, a useful property when reasoning about real-time dependencies.
This example does not measure scheduling, priority inheritance or worst-case response time; it is not a timing benchmark.

## Walk through the code
All line numbers below refer to [`examples/msgpass/src/msgpass.c`](../examples/msgpass/src/msgpass.c); excerpts preserve the source text.

Lines 72 and 78 create a private channel and attach a connection to this process:
```c
    chid = ChannelCreate(_NTO_CHF_PRIVATE);
    coid = ConnectAttach(0, 0, chid, _NTO_SIDE_CHANNEL, 0);
```
These are separate source lines, with error checks between them. Line 83 starts the server thread.

The server receives each request at line 42:
```c
        rcvid = MsgReceive(chid, &request, sizeof(request), &info);
```
Lines 33–37 provide a union large enough for a pulse. Lines 43–51 reject receive errors, unexpected pulses and unexpected message sizes.

Lines 54–57 double the integer and reply using the received message identifier:
```c
        reply = request.number * 2;
        if (MsgReply(rcvid, 0, &reply, sizeof(reply)) == -1) {
            fail("MsgReply", errno);
        }
```
The reply carries status zero and a separate integer payload.

The client sends its request and supplies the reply buffer at lines 91–92:
```c
        long status = MsgSend(coid, &numbers[i], sizeof(numbers[i]),
                              &reply, sizeof(reply));
```
Line 64 supplies 7, 11 and 21. Lines 93–98 check both the returned status and the doubled value.
Lines 104–113 join the server, detach the connection and destroy the channel.

## Compile for the Part 1 image
Save the complete, unchanged [source](../examples/msgpass/src/msgpass.c) as `/root/qnx-tutorial-src/msgpass.c` and compile it with the same qcc pattern as Part 1:
```bash
cd /root/qnx-tutorial-src
source /root/qnx800/qnxsdp-env.sh
qcc -Vgcc_ntox86_64 -o automata-msgpass msgpass.c
```
Verified on 6 November 2026: the command returned 0 without extra compiler or linker options and produced a 13,992-byte x86-64 ELF with interpreter `/usr/lib/ldqnx-64.so.2`, the same size as the MCP build recorded on 4 November.

## Add it to the existing image
Keep the existing image and hello snippets. After successful compilation, copy the new executable:
```bash
cp /root/qnx-tutorial-src/automata-msgpass /root/qnx-tutorial-run/automata-msgpass
```
Append its own mapping to `local/snippets/ifs_files.custom` in that image directory:
```text
[perms=0755] automata-msgpass=/root/qnx-tutorial-run/automata-msgpass
```
Append these recorded commands to `local/snippets/post_start.custom`, after the hello block:
```sh
echo "QNX_MSGPASS_RUN_BEGIN"
/proc/boot/automata-msgpass
echo "QNX_MSGPASS_RUN_EXIT=$?"
```
Keep the exit-status echo immediately after the executable. Rebuild the existing image:
```bash
cd /root/qnx-tutorial-run
mkqnximage --noprompt --build
```
In Part 1's launcher, change the wait marker from `QNX_MCP_RUN_EXIT` to `QNX_MSGPASS_RUN_EXIT`; retain its early-exit check. Otherwise the earlier hello marker can end the wait before this example finishes.
The adjusted launcher is saved as [`run-qemu-part2.sh`](run-qemu-part2.sh). In the 6 November run the rebuild returned 0, and the message-passing marker appeared 24 seconds after QEMU started.

## Expected and observed output
The 6 November run printed this block right after the Part 1 hello block, in the same boot. The 4 November recording has the same lines at 27–32 of its `qemu-serial-console.txt`:
```text
QNX_MSGPASS_RUN_BEGIN
msgpass: sent 7 got 14
msgpass: sent 11 got 22
msgpass: sent 21 got 42
msgpass: ok
QNX_MSGPASS_RUN_EXIT=0
```
The four program lines match [`examples/msgpass/expected-output.txt`](../examples/msgpass/expected-output.txt) exactly. The outer markers come from the startup snippet.
Check the guest exit marker in your own run; QEMU termination status is separate. No response-time bound was measured.

## Common problems
- **Direct compilation fails:** source `qnxsdp-env.sh` in the same shell and preserve the diagnostic; the verified build needed no extra options.
- **Executable missing in the guest:** check the copied file, its host path in `ifs_files.custom`, and whether the rebuild succeeded.
- **Only hello output appears:** check the appended startup block and the launcher's message-passing wait marker.
- **Unexpected pulse or size:** the server deliberately rejects these at lines 46–51; this is a fixed three-integer demonstration.
- **Exchange fails:** `fail()` at lines 19–25 reports the call and error, then terminates the process so a client cannot remain blocked after a server failure.

## Files and evidence
- [`../examples/msgpass/src/msgpass.c`](../examples/msgpass/src/msgpass.c) and [`expected-output.txt`](../examples/msgpass/expected-output.txt): the program and its expected lines.
- [`run-qemu-part2.sh`](run-qemu-part2.sh): the Part 1 launcher with the message-passing marker.
- [`verification-part2-2026-11-06.txt`](verification-part2-2026-11-06.txt): console output of the 6 November run of this part.
- [`../evidence/qemu-run-msgpass-20261104/`](../evidence/qemu-run-msgpass-20261104/): the first run, compiled through the MCP server on 4 November 2026.

Back to [Part 1](README.md). Next: [Part 3](part3-resource-manager.md), a resource manager in the same image.

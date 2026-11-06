# Part 3: A QNX resource manager

Continue from [Part 2](part2-message-passing.md): expose message handling through ordinary file operations.
This chapter uses [`examples/resmgr/src/resmgr.c`](../examples/resmgr/src/resmgr.c), its [README](../examples/resmgr/README.md) and the run recorded in [`evidence/qemu-run-resmgr-20261106/`](../evidence/qemu-run-resmgr-20261106/README.md).
Line numbers below refer to that 200-line source; the recorded guest run took place on 6 November 2026.

## A device accessed with open and read

A resource manager registers a pathname and handles requests made through that name. Here `/dev/automata-echo` exposes a fixed 33-byte message through a read-only character-device interface.
The client uses ordinary `open` and `read`; the resource-manager framework routes requests to server handlers. Both sides run in one process: a server thread handles requests while the main thread acts as the client.

## Create and register the server

In `src/resmgr.c`, line 84 creates the dispatch interface; lines 90–93 initialize default handlers and the device attributes:
```c
dispatch = dispatch_create();
```
```c
iofunc_func_init(_RESMGR_CONNECT_NFUNCS, &connect_functions,
                 _RESMGR_IO_NFUNCS, &io_functions);
io_functions.read = io_read;
iofunc_attr_init(&attributes, S_IFCHR | 0444, NULL, NULL);
```
The custom read handler replaces the default read entry. Lines 96–98 register the pathname:
```c
    if (resmgr_attach(dispatch, &resource_attributes, device_path,
                      _FTYPE_ANY, _RESMGR_FLAG_SELF, &connect_functions,
                      &io_functions, &attributes) == -1) {
```
Line 101 allocates a dispatch context; line 105 then publishes server readiness.

## Reply to reads and advance the offset

`io_read` starts at line 35 and calls `iofunc_read_verify` at line 44. Lines 56–60 return zero bytes for a zero-length request or an offset at the end of the payload.
Lines 61–65 limit the reply to the requested count and the remaining bytes. Lines 66–68 prepare the reply and advance the open control block's offset:
```c
    SETIOV(ctp->iov, (void *)(message + offset), count);
    _IO_SET_READ_NBYTES(ctp, count);
    ocb->offset += (off_t)count;
```
The payload excludes its terminating NUL. Repeated reads eventually receive zero bytes, indicating EOF.

## Dispatch requests and read seven bytes at a time

Inside the server loop, line 108 waits for work and line 115 dispatches it; these are separate excerpts:
```c
        next = dispatch_block(context);
```
```c
        if (dispatch_handler(context) == -1) {
```
The surrounding checks handle failures, and line 112 retains the context returned by `dispatch_block`.
The client starts the server at line 134, waits for registration at lines 139–155, and opens the device at line 156.
Line 163 limits each request; line 169 performs the ordinary read, with intervening declarations and checks omitted here:
```c
        size_t request = capacity < 7 ? capacity : 7;
```
```c
        received = read(descriptor, buffer + total, request);
```
Lines 173–179 detect EOF and accumulate bytes; lines 181–184 verify the complete payload. Returning from `main` terminates the server thread and removes its registered path.

## The same-process pathname trap

The first build compiled, but the guest reported `resmgr: wait for /dev/automata-echo failed: errno=260`.
An instrumented copy showed successful `resmgr_attach` while `stat` and `open` returned `ENOENT`. By default, QNX does not resolve a pathname back to the process that registered it.
Passing `_RESMGR_FLAG_SELF` fixed the run: the SDK description quoted in the example README is “Allow resolving names to itself”.
The default protects a single-threaded manager from waiting forever for its own request when no thread can receive it. This example has a separate server thread available to receive and reply while the client waits.

## Compile directly or through MCP

From `examples/resmgr`, use Part 1's SDK environment and target selection with this example's source and output names:
```bash
source /root/qnx800/qnxsdp-env.sh
qcc -Vgcc_ntox86_64 -o automata-resmgr src/resmgr.c
```
The evidence also records `qcc -Vgcc_ntox86_64 -Wall -o automata-resmgr src/resmgr.c`, returning 0 without warnings.
Alternatively, from the QNX MCP project root with the SDK environment loaded, run `node scripts/compile-example.mjs examples/resmgr src/resmgr.c`.
That script calls `qnx_compile_c`, polls `qnx_operation_status`, and verifies the artifact size and SHA-256.
The saved result records `succeeded`, exit code 0, and a 14344-byte artifact at `build/7e29e0b654bccb7758b70aa8206244df/program` relative to `examples/resmgr`.

## Include the executable in the tutorial image

Stage the chosen executable at `/root/qnx-tutorial-run/automata-resmgr`; the recorded guest used the unchanged MCP artifact.
Preserve the existing snippets. The evidence's `ifs_files.custom` contains this resource-manager entry:
```text
[perms=0755] automata-resmgr=/root/qnx-tutorial-run/automata-resmgr
```
Its `post_start.custom` runs the example after the earlier examples with these markers:
```sh
echo "QNX_RESMGR_RUN_BEGIN"
/proc/boot/automata-resmgr
echo "QNX_RESMGR_RUN_EXIT=$?"
```
Use the generated `local/snippets/` files, rebuild with `mkqnximage --noprompt --build`, and boot as in Part 1.

## Recorded output and common problems

The saved [`qemu-serial-console.txt`](../evidence/qemu-run-resmgr-20261106/qemu-serial-console.txt) contains:
```text
QNX_RESMGR_RUN_BEGIN
resmgr: read 33 bytes: hello from a QNX resource manager
resmgr: ok
QNX_RESMGR_RUN_EXIT=0
```
The two program lines match [`examples/resmgr/expected-output.txt`](../examples/resmgr/expected-output.txt); the exit marker records successful execution.
For same-process `ENOENT`, check `_RESMGR_FLAG_SELF` and that a server thread can receive requests.
The `void *` cast in line 66 addresses the original `SETIOV` const-pointer warning; the corrected direct build had no warnings.
Other failures print diagnostics and terminate the demonstration. The recorded guest had no network interface; networking and sshd startup messages are unrelated.
This chapter does not cover a persistent service (the path disappears when `main` returns) or operations beyond ordinary reads. The run shown is the 6 November 2026 evidence of the published example.

Back to [Part 1](README.md) or [Part 2](part2-message-passing.md).

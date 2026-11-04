# Native QNX message passing

This single-file example demonstrates QNX 8.0 synchronous message passing between two threads in one process. The main thread is the client; a pthread is the server.

`ChannelCreate(_NTO_CHF_PRIVATE)` creates a process-private channel. `ConnectAttach` creates a side-channel connection without occupying a file descriptor. For each of three integers, the client calls `MsgSend`, the server receives the request with `MsgReceive`, and `MsgReply` returns twice the number. The client prints only after receiving and checking each reply, so successful output is deterministic. After the third exchange, the client joins the server and releases the connection and channel.

The receive buffer accommodates a QNX pulse. Unexpected pulses, message sizes, reply statuses and reply values are treated as errors. Failed calls report their name and numeric error code on standard error and terminate the process with a nonzero exit status. For pthread calls, the diagnostic uses the returned error number rather than assuming that errno was set. Terminating the process on a server failure also prevents leaving the client blocked indefinitely.

## Expected output

Successful standard output is exactly:

```text
msgpass: sent 7 got 14
msgpass: sent 11 got 22
msgpass: sent 21 got 42
msgpass: ok
```

The expected exit status is `0`, with no standard-error output.

## Compiled through MCP and run on QNX 8.0 (2026-11-04)

Evidence: [evidence/qemu-run-msgpass-20261104](../../evidence/qemu-run-msgpass-20261104/README.md).

- Compiled through the MCP server with `qnx_compile_c` for `src/msgpass.c`, polled with `qnx_operation_status`: `succeeded`, exit code 0, a 13992-byte x86-64 ELF using `/usr/lib/ldqnx-64.so.2`, SHA-256 `1e928f1699eb8ecf7b40850043347a31eaeb313c26f3fd9945bb8dc6c71901e0`, independently re-hashed by the client.
- The unchanged binary ran inside QNX 8.0.0 x86_64 in QEMU 8.2.2. Its four output lines match the block above exactly and the exit status was 0.

To reproduce the compilation, load the licensed SDK environment and run from the repository root:

```bash
node scripts/compile-example.mjs examples/msgpass src/msgpass.c
```

The MCP image lifecycle tools remain blocked: the binary was placed in the guest image with the SDK image tools, as described in [REAL-QNX.md](../../docs/REAL-QNX.md). QEMU boot messages and execution markers in the console are separate from the program's own output.

## Official references

The source comment links to the QNX 8.0 library references consulted for `ChannelCreate`, `ConnectAttach`, `MsgSend`, `MsgReceive` and `MsgReply`. The example uses QNX and standard C headers, a single source file, and no external dependencies.

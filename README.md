# QNX Host MCP

MCP server over stdio for inspecting a configured QNX compiler and compiling workspace C sources with fixed arguments. Operations return an ID for status polling and cancellation.

Real compilation and execution of the unchanged artifact inside QNX 8.0.0 x86_64 in QEMU 8.2.2 were completed on the project host. [Guest execution evidence](evidence/qemu-run-20261103/README.md) records the expected message and exit status 0.

A second example, [native QNX message passing](examples/msgpass/README.md), uses `ChannelCreate`, `ConnectAttach`, `MsgSend`, `MsgReceive` and `MsgReply` between two threads. It was compiled through MCP with `node scripts/compile-example.mjs examples/msgpass src/msgpass.c` and run on QNX 8.0 in QEMU with the expected output and exit status 0 ([evidence](evidence/qemu-run-msgpass-20261104/README.md)).

A third example, a [QNX resource manager](examples/resmgr/README.md), registers `/dev/automata-echo` with `resmgr_attach` and a custom `io_read` handler, and the same process reads it back through `open` and `read`. It was compiled through MCP with `node scripts/compile-example.mjs examples/resmgr src/resmgr.c` and run on QNX 8.0 in QEMU with the expected output and exit status 0 ([evidence](evidence/qemu-run-resmgr-20261106/README.md)).

## Start here

QNX Host MCP is a stdio MCP server for inspecting a configured QNX compiler and compiling workspace C sources with fixed arguments.

| Resource | What it shows | Evidence |
| --- | --- | --- |
| [Demo video](https://youtu.be/QTPR1CjDbIU) | Watch the demo | — |
| [Tutorial: Part 1](tutorial/README.md) | Compile a QNX C program, build an image and run it in QEMU | [Verification log](tutorial/verification-2026-11-06.txt) |
| [Tutorial: Part 2](tutorial/part2-message-passing.md) | Native synchronous message passing | [Verification log](tutorial/verification-part2-2026-11-06.txt) |
| [Tutorial: Part 3](tutorial/part3-resource-manager.md) | A resource manager accessed with ordinary file operations | [Recorded run](evidence/qemu-run-resmgr-20261106/) |
| [Hello example](examples/hello/) | QNX-target C compilation and guest execution | [Recorded run](evidence/qemu-run-20261103/) |
| [Message-passing example](examples/msgpass/) | `ChannelCreate`, `ConnectAttach`, `MsgSend`, `MsgReceive`, `MsgReply` | [Recorded run](evidence/qemu-run-msgpass-20261104/) |
| [Resource-manager example](examples/resmgr/) | `resmgr_attach`, custom `io_read`, ordinary `open` and `read` | [Recorded run](evidence/qemu-run-resmgr-20261106/) |

### Try it

1. Prepare Node.js 22 or later and the existing project dependencies; load the licensed QNX SDK environment for real compilation.
2. Follow [Configuration](#configuration): set an absolute `QNX_MCP_WORKSPACE` containing `src/hello.c`, provide a trusted compiler `PATH`, and configure the stdio MCP client.
3. From the repository root, run `npm run smoke:fake` for simulated validation or `npm run smoke` with the SDK environment loaded for real compilation and artifact verification.
4. Follow [Tutorial Part 1](tutorial/README.md) for the separate SDK image and QEMU workflow, then continue with Parts 2 and 3 above.

The compilation smoke does not execute the artifact; MCP image lifecycle tools remain blocked with `UNSAFE_CONFIGURATION`.

## Configuration

Requires Node.js 22 or later and the existing project dependencies. Configure an absolute QNX_MCP_WORKSPACE directory containing src/hello.c and a trusted PATH containing the QNX executables. The server resolves executables from absolute PATH entries and invokes them without a shell. It forwards selected host and QNX environment variables only.

Example Claude Code configuration:

```json
{
  "mcpServers": {
    "qnx-host": {
      "command": "node",
      "args": ["/absolute/path/qnx-mcp/src/server.mjs"],
      "env": {
        "QNX_MCP_WORKSPACE": "/absolute/path/qnx-workspace",
        "PATH": "/absolute/path/to/qnx/compiler/bin:/usr/bin:/bin"
      }
    }
  }
}
```

The project environment uses QNX SDP 8.0 on Ubuntu 24.04 under WSL2. Compiler evidence identifies GCC 12.2.0 and the QNX x86_64 target. SDK installation and licensing were not audited by this documentation update.

## Compilation smoke and evidence

Run from the repository root after loading the licensed SDK environment:

```bash
npm run smoke
```

For validation without the SDK:

```bash
npm run smoke:fake
```

The smoke uses the installed MCP Client and StdioClientTransport to launch src/server.mjs, list tools, inspect the compiler, compile examples/hello/src/hello.c and poll operation status with bounded waits. It writes report.json and report.md under evidence/<timestamp>-<unique-suffix>/. Use --evidence-root DIRECTORY to select another report destination.

Reports include compiler version and target output, operation exit codes, reconstructed compiler arguments, artifact size and SHA-256. Arguments come from the fixed executor contract, not a server-provided execution trace. The smoke independently verifies artifact size and hash. Fake mode additionally checks arguments recorded by the simulated compiler.

Fake reports identify simulated evidence and do not demonstrate QNX compatibility. Real mode uses the operator's PATH; inspect compiler output alongside environment details. The compilation smoke does not execute artifacts or call image tools.

### Retained real compilation — 2026-11-03

Evidence: [report.json](evidence/2026-11-03T20-25-05.120Z-q4xWZQ/report.json), [report.md](evidence/2026-11-03T20-25-05.120Z-q4xWZQ/report.md) and [host-facts.txt](evidence/host-facts.txt). JSON and Markdown describe one run.

| Field | Recorded value |
| --- | --- |
| Start | 2026-11-03T20:25:05.120Z |
| Finish | 2026-11-03T20:25:05.431Z |
| Result | mode=real; simulated=false; success=true |
| Compiler inspection | succeeded; exitCode=0 |
| Compiler | GCC 12.2.0 |
| Default target | 12.2.0,gcc_ntox86_64 |
| Target configuration directory | /root/qnx800/host/linux/x86_64/etc/qcc |
| Compilation | succeeded; exitCode=0 |
| Compile operation | 0279c855d511a150ba531331739c259b |
| Workspace-relative artifact | build/0279c855d511a150ba531331739c259b/program |
| Size | 9208 bytes |
| SHA-256 | e5596d9e949d480cf1c129c6dbcd98adec84661edad263e40af204991dc6e798 |
| ELF identification | x86-64; interpreter /usr/lib/ldqnx-64.so.2 |
| Execution by compilation smoke | Not performed; subsequent guest execution is recorded separately below |

The report represents the source as `/path/to/qnx-mcp/examples/hello/src/hello.c` and output as `/path/to/qnx-mcp/examples/hello/build/0279c855d511a150ba531331739c259b/program`. These are recorded project-host paths. The fixed target argument is `-Vgcc_ntox86_64`.

The report records `independentlyVerified: true` and `retained: true`. This documentation update inspected records without rehashing binaries or checking current retention. The output does not identify an additional SDK patch version. Exact compiled source-commit provenance remains unestablished. See [REAL-QNX.md](docs/REAL-QNX.md) for compiler reproduction guidance.

For the separate SDK image and QEMU reproduction procedure, see [Real QNX compilation and guest execution](docs/REAL-QNX.md). Retained evidence files preserve original host paths; adapt working copies for a new run.

## Successful QNX guest execution — 2026-11-03

Evidence: [execution README](evidence/qemu-run-20261103/README.md), [serial console](evidence/qemu-run-20261103/qemu-serial-console.txt) and [hash records](evidence/qemu-run-20261103/sha256.txt). The separate SDK/QEMU workflow ran on the project host: Ubuntu 24.04 on WSL2, kernel `6.6.87.2-microsoft-standard-WSL2`, QEMU 8.2.2 from the Ubuntu archive. It used TCG with `-cpu max`; no KVM device was available.

```text
QNX_MCP_RUN_BEGIN
QNX noname 8.0.0 2026/06/05-16:26:03EDT x86pc x86_64
Hello from QNX MCP smoke.
QNX_MCP_RUN_EXIT=0
```

The unchanged 9208-byte program has the same SHA-256 recorded by the compiler smoke. `sha256.txt` matches the original program and `automata-hello`; the recorded `output/ifs.bin` SHA-256 is `e606657ba117cbdb05ddea7385e92f5493e0b7712c82ce368fa15285be72f8fe`. The execution README reports three independent compilations with the same program hash; additional compilation reports were not inspected here.

The SDK's `mkqnximage --type=qemu --arch=x86_64 --graphics=no`, using `/root/qnx800/target/qnx`, built the image. As described in the evidence README, `ifs_files.custom` places the unchanged artifact at `/proc/boot/automata-hello`; `post_start.custom` runs it during startup and prints its exit status. No login was performed. The retained `run-qemu.sh` is described as waiting for the marker and stopping QEMU with SIGTERM. This update did not run these files.

The guest had no network interface. Its unedited console reports `no valid interfaces found` and an sshd startup failure, `Memory fault (core dumped)`, before the successful program output. Networking and SSH operation were not validated. The SDK image tools placed the artifact; the MCP server did not transfer it. All four MCP image lifecycle tools remain blocked with UNSAFE_CONFIGURATION.

## MCP tools

- qnx_toolchain_info: fixed qcc --version and qcc -V commands; 30-second deadline.
- qnx_compile_c: accepts src/name.c, compiles for QNX x86_64 and checks build/<operationId>/program; 120-second deadline. Returns artifact path, size and SHA-256.
- qnx_operation_status and qnx_operation_cancel: supervise operation IDs created by this executor. Cancellation acceptance precedes confirmed termination.
- qnx_image_build, qnx_image_start, qnx_image_ip and qnx_image_stop: remain blocked with UNSAFE_CONFIGURATION.

Output is capped at 32 KiB per stream. Excess output is drained and reported as OUTPUT_LIMIT. Process cancellation targets the operation's Linux process group and escalates after the configured grace period. Native Windows process execution remains disabled.

## Image configuration

QNX_MCP_IMAGE_CONFIG optionally names an absolute operator-controlled JSON file containing exactly:

```json
{
  "version": 1,
  "enabled": false
}
```

Absent configuration defaults to disabled. Invalid configuration prevents startup. enabled=true does not activate the MCP image tools. The separate SDK/QEMU execution evidence does not change this gate.

## Internal image lifecycle

Executor.imageOperation(action, imageName) is an internal interface for direct tests; the MCP dispatcher does not invoke it. Actions are build, start, ip and stop. Names contain 1–32 lowercase ASCII letters, digits or hyphens. Image directories reside under workspace/images/<name>.

Commands use fixed arguments: --type=qemu --arch=x86_64 followed by --build, --run, --getip or --stop. Deadlines are respectively 900, 60, 20 and 30 seconds. An internal image operation starts only when no operation is active. Images must have been built by the same executor before start; IP lookup and stop require a recorded instance.

Internal startup retains a persistent launcher, reads output/qemu.pid and checks captured Linux process identities and ancestry. Socket observation uses Linux procfs unless a test observer is injected. The unsafeListeningPorts function checks owned TCP listeners against exact 127.0.0.1 and ::1. This point-in-time observation does not establish network isolation or guest readiness.

Stop checks ownership before invoking the fixed --stop command. Cleanup observes removal of the captured target and launcher and may fall back to signalling the captured launcher group after identity checks. Unconfirmed cleanup returns CANCEL_FAILED. Controlled-process tests and the separate SDK/QEMU guest run do not establish the real mkqnximage ownership and stop behavior of this internal executor.

See [Image notes](docs/IMAGE-NOTES.md), [Launcher validation](docs/LAUNCHER-VALIDATION.md) and [Demo plan](docs/DEMO.md). All four MCP image tools remain blocked pending verified host controls.

## Tests

```bash
npm test
```

Reported results on the project host comprise six consecutive complete WSL runs, each passing 60/60, and an integrated-project run passing 60/60. Their underlying suite logs were not inspected for this update. Separately, the isolated Linux candidate previously produced an observed result of 60 passed, zero failed, zero cancelled and zero skipped.

Regression tests use fake executables, controlled Linux processes and supplied socket tables. Guest execution is supported by the separate retained console evidence, rather than those regression tests. No tests were repeated for this documentation update. The CI workflow specifies Ubuntu and Node 22; execution on GitHub remains unverified.

## Scope and limitations

Real compilation and subsequent guest execution are supported by separate retained evidence. The compilation smoke does not run artifacts. The SDK/QEMU workflow records QNX 8.0.0 x86_64, expected program output and exit status 0. It does not establish networking, SSH, MCP image lifecycle operation or host isolation. The guest had no network interface and sshd startup failed with a memory fault. No login was performed.

Canonical path checks do not provide operating-system isolation. Persisted image configuration, actual stop scope, descendant ownership and live networking require verification before enabling MCP image execution. Use trusted source files and an operator-controlled workspace.

The retained evidence was produced from a working copy of this source before publication; the exact source revision it was compiled from is not recorded in the reports.

## QNX Global Hackathon

This project is an entry for the QNX Global Hackathon, Developer Tooling and Host Tools category. The evidence is summarized in [EVIDENCE.md](docs/EVIDENCE.md) and the demonstration plan is in [DEMO.md](docs/DEMO.md). The simulated demonstration remains a labeled rehearsal.

Publication note: project and validation paths in this document use neutral placeholders. Consult the unchanged evidence files for original recorded paths.

## Tutorial

Step by step, verified on 6 November 2026: [Run a QNX 8.0 C program in QEMU from Windows](tutorial/README.md) (WSL2 and Ubuntu 24.04, qcc, a custom mkqnximage image and a captured serial console, without hardware or a guest login), [Part 2: native QNX message passing](tutorial/part2-message-passing.md) and [Part 3: a resource manager](tutorial/part3-resource-manager.md) in the same image.

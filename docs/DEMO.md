# Devpost video plan — 2 minutes 45 seconds

Category: **Developer Tooling and Host Tools**.

Status: recording plan only. Real compilation and execution of the unchanged artifact inside QNX 8.0.0 x86_64 in QEMU 8.2.2 were completed on the project host. Public repository, video and Devpost form remain pending.

## Primary plan: compilation and guest execution

The project environment uses QNX SDP 8.0 on Ubuntu 24.04 under WSL2. Compiler output records GCC 12.2.0, default target `12.2.0,gcc_ntox86_64` and configuration directory `/root/qnx800/host/linux/x86_64/etc/qcc`. No additional SDK patch version is inferred.

Use the retained compiler evidence in `evidence/2026-11-03T20-25-05.120Z-q4xWZQ/`, `evidence/host-facts.txt` and the separate guest evidence in [qemu-run-20261103](../evidence/qemu-run-20261103/README.md). Label playback of retained evidence; do not present it as a new live execution. Any separately authorized new run must use its own corresponding reports.

| Time | Screen | English narration and evidence condition |
| --- | --- | --- |
| 0:00–0:15 | Title and category | QNX Host MCP gives an AI coding assistant an inspectable interface to host development tools. |
| 0:15–0:35 | Source, environment and compiler output | Identify QNX SDP 8.0, Ubuntu 24.04 / WSL2, GCC 12.2.0 and the QNX x86_64 target. Describe the run as performed on the project host. |
| 0:35–1:05 | MCP smoke reports | Explain tool listing, compiler inspection, fixed-argument compilation and operation polling. Show mode=real, simulated=false, success=true and both exit codes 0. Arguments are reconstructed from the executor contract. |
| 1:05–1:25 | Artifact and hash records | Show the 9208-byte artifact and matching hashes for the original program and automata-hello. Distinguish the compilation smoke from the separate guest run. |
| 1:25–1:55 | Retained guest serial console | Show QNX 8.0.0 x86_64, Hello from QNX MCP smoke. and QNX_MCP_RUN_EXIT=0. Identify QEMU 8.2.2 and label the retained run. |
| 1:55–2:20 | SDK snippets, console warnings and MCP gates | Explain that SDK image tools placed the artifact, not MCP. The guest had no network interface and sshd failed with a memory fault. All four MCP image tools remain blocked. |
| 2:20–2:45 | README, MIT LICENSE, evidence and limits | End with reproduction guidance and the successful compilation and guest-execution results. MCP image lifecycle, networking, SSH and host isolation are not validated by this run. |

## Exact retained compiler evidence

- [report.json](../evidence/2026-11-03T20-25-05.120Z-q4xWZQ/report.json), [report.md](../evidence/2026-11-03T20-25-05.120Z-q4xWZQ/report.md) and [host-facts.txt](../evidence/host-facts.txt).
- Start `2026-11-03T20:25:05.120Z`; finish `2026-11-03T20:25:05.431Z`. The two report formats describe one run.
- Compile operation: `0279c855d511a150ba531331739c259b`.
- Source: `/path/to/qnx-mcp/examples/hello/src/hello.c`.
- Artifact: `/path/to/qnx-mcp/examples/hello/build/0279c855d511a150ba531331739c259b/program`.
- Size: 9208 bytes.
- SHA-256: `e5596d9e949d480cf1c129c6dbcd98adec84661edad263e40af204991dc6e798`.
- ELF interpreter: `/usr/lib/ldqnx-64.so.2`.

The smoke records independent size and hash verification. Its non-execution note describes the compilation smoke, before the subsequent guest run. Exact source-commit provenance remains unestablished.

## Exact retained guest evidence

[Execution README](../evidence/qemu-run-20261103/README.md), [serial console](../evidence/qemu-run-20261103/qemu-serial-console.txt) and [hash records](../evidence/qemu-run-20261103/sha256.txt) document execution on the project host: Ubuntu 24.04 on WSL2, kernel `6.6.87.2-microsoft-standard-WSL2`, QEMU 8.2.2 from the Ubuntu archive. QEMU used TCG with `-cpu max`; no KVM device was available.

```text
QNX_MCP_RUN_BEGIN
QNX noname 8.0.0 2026/06/05-16:26:03EDT x86pc x86_64
Hello from QNX MCP smoke.
QNX_MCP_RUN_EXIT=0
```

The SDK's `mkqnximage --type=qemu --arch=x86_64 --graphics=no`, using `/root/qnx800/target/qnx`, built the image. The evidence README describes `ifs_files.custom` placing the unchanged program at `/proc/boot/automata-hello` and `post_start.custom` running it during startup. No login was performed. It describes `run-qemu.sh` waiting for the exit marker and stopping QEMU with SIGTERM. These files are retained in the evidence directory; this update did not run them.

Recorded `output/ifs.bin` SHA-256: `e606657ba117cbdb05ddea7385e92f5493e0b7712c82ce368fa15285be72f8fe`. The hash records match the original artifact and `automata-hello`. The evidence README reports three independent compilations with the same program hash; additional compilation reports were not inspected here.

Keep the unedited console warnings visible or explain them: the guest had no network interface, reports `no valid interfaces found`, and its sshd startup fails with `Memory fault (core dumped)`. The program then prints its expected message and exits with status 0. This does not establish networking or SSH operation. SDK image tools placed the artifact; the MCP server did not transfer it, and its four image tools remain blocked with UNSAFE_CONFIGURATION.

## Simulated backup — rehearsal only

Use `npm run smoke:fake` only as a clearly marked integration rehearsal, with **SIMULATED — FAKE EXECUTABLES — NO REAL QNX COMPILATION** visible. Fake reports show mode=fake and simulated=true; their artifact is diagnostic data. Use the real compiler reports for compilation claims and the separate guest evidence for execution claims.

## Before publication

- Match displayed compiler reports, artifact hashes and guest evidence.
- Associate the evidence with its exact source revision.
- Review paths and screens for credentials, license material and private details.
- Keep the exported video strictly below three minutes; this plan targets 2:45.
- Verify the public repository, LICENSE, evidence links and video playback.
- Complete and submit the Devpost form with the verified links.
- Preserve the networking, sshd and SDK-versus-MCP limits in the narration.

No installation, new compilation, regression run, QEMU execution, server launch, account creation, recording or publication was performed by this documentation update.

Publication note: project and validation paths in this document use neutral placeholders. Consult the unchanged evidence files for original recorded paths.

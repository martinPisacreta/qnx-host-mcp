# QNX compilation, guest execution and validation evidence

Recorded: 2026-11-03. This document distinguishes inspected compiler reports, host metadata, retained guest-console and hash evidence, and reported regression results on the project host. No compilation, QEMU run or regression tests were repeated for this documentation update.

## Inspected evidence

- [Compiler report.json](../evidence/2026-11-03T20-25-05.120Z-q4xWZQ/report.json).
- [Compiler report.md](../evidence/2026-11-03T20-25-05.120Z-q4xWZQ/report.md).
- [Host metadata](../evidence/host-facts.txt).
- [Guest execution README](../evidence/qemu-run-20261103/README.md).
- [Guest serial console](../evidence/qemu-run-20261103/qemu-serial-console.txt).
- [Guest artifact and image hashes](../evidence/qemu-run-20261103/sha256.txt).

The JSON and Markdown compiler reports describe one smoke run. The guest evidence records a separate SDK/QEMU workflow. Startup snippets and the run script are retained in `evidence/qemu-run-20261103/`; their behavior below is described by its inspected README, without claiming separate script review or re-execution.

## Real compiler smoke

The report records `mode: real`, `simulated: false`, `success: true`, start `2026-11-03T20:25:05.120Z` and finish `2026-11-03T20:25:05.431Z`. Compiler inspection and compilation both reached `succeeded` with exit code 0 and no recorded error code. Compilation stdout and stderr were empty and not truncated.

The smoke called compiler inspection, compilation and operation-status tools. It did not execute the artifact or call image tools. Its historical non-execution note describes that smoke, before the subsequent guest run.

The project environment is QNX SDP 8.0 on Ubuntu 24.04 / WSL2. Compiler output identifies GCC 12.2.0, default target `12.2.0,gcc_ntox86_64` and configuration directory `/root/qnx800/host/linux/x86_64/etc/qcc`. No additional SDK patch release is inferred. Installation and licensing were not audited during this documentation task.

### Source and reconstructed arguments

The report identifies workspace `/path/to/qnx-mcp/examples/hello` and source `src/hello.c`:

```text
-Vgcc_ntox86_64
-o
build/0279c855d511a150ba531331739c259b/program
src/hello.c
```

Its absolute-path representation is:

```text
-Vgcc_ntox86_64
-o
/path/to/qnx-mcp/examples/hello/build/0279c855d511a150ba531331739c259b/program
/path/to/qnx-mcp/examples/hello/src/hello.c
```

Both representations are reconstructed from the fixed executor contract, not a server-provided execution trace. The reports do not establish the exact compiled source commit or source-file digest.

### Artifact

| Field | Recorded value |
| --- | --- |
| Compile operation | `0279c855d511a150ba531331739c259b` |
| Workspace-relative artifact | `build/0279c855d511a150ba531331739c259b/program` |
| Size | 9208 bytes |
| SHA-256 | `e5596d9e949d480cf1c129c6dbcd98adec84661edad263e40af204991dc6e798` |
| Smoke verification | `independentlyVerified: true` |
| Original retention | `retained: true` |
| Execution | Not performed by compilation smoke; subsequently recorded in guest evidence below |

The host metadata records:

```text
ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /usr/lib/ldqnx-64.so.2, BuildID[md5/uuid]=ef24df11be439775b5729c6e6db4fcd4, with debug_info, not stripped
```

It records GCC 12.2.0 and the same artifact hash. Verification flags describe the smoke runner's checks; this documentation update inspected records without rehashing binaries or checking current retention.

## Successful execution inside QNX in QEMU

The separate evidence in [qemu-run-20261103](../evidence/qemu-run-20261103/README.md) documents execution on the project host: Ubuntu 24.04 on WSL2, kernel `6.6.87.2-microsoft-standard-WSL2`, QEMU 8.2.2 from the Ubuntu archive. QEMU used TCG with `-cpu max`; no KVM device was available.

The inspected serial console records:

```text
QNX_MCP_RUN_BEGIN
QNX noname 8.0.0 2026/06/05-16:26:03EDT x86pc x86_64
Hello from QNX MCP smoke.
QNX_MCP_RUN_EXIT=0
```

The guest identifies itself as QNX 8.0.0 x86_64. The artifact prints its expected line and returns status 0. Guest execution is therefore supported by retained console evidence and is no longer pending.

### Image construction and artifact identity

The execution README documents `mkqnximage --type=qemu --arch=x86_64 --graphics=no`, using `/root/qnx800/target/qnx`. The image was rebuilt with `ifs_files.custom`, which places the unchanged artifact at `/proc/boot/automata-hello`, and `post_start.custom`, which runs it at the end of startup and prints its exit status. No login was performed. The README describes `run-qemu.sh` waiting for the exit marker and stopping QEMU with SIGTERM.

The inspected `sha256.txt` records:

```text
e5596d9e949d480cf1c129c6dbcd98adec84661edad263e40af204991dc6e798  automata-hello
e606657ba117cbdb05ddea7385e92f5493e0b7712c82ce368fa15285be72f8fe  output/ifs.bin
e5596d9e949d480cf1c129c6dbcd98adec84661edad263e40af204991dc6e798  /path/to/qnx-mcp/examples/hello/build/0279c855d511a150ba531331739c259b/program
```

These records match the original 9208-byte compiled program and the artifact placed in the image. The execution README also reports three independent compilations producing that program hash; additional compilation reports were not inspected in this update. No binaries were rehashed here.

### Execution limits

- The guest was started without a network interface. The unedited console records `ifconfig: interface vtnet0 does not exist` and `no valid interfaces found`.
- The image's sshd startup fails with `Memory fault (core dumped)`. The program subsequently prints its expected message and exits with status 0. Networking and SSH operation were not validated.
- SDK image tools placed the artifact; the MCP server did not transfer it.
- All four MCP image lifecycle tools remain blocked with UNSAFE_CONFIGURATION. The SDK/QEMU run does not validate or activate them.
- No login was performed; execution relied on the startup snippet.
- This run does not establish host isolation, network isolation or end-to-end image lifecycle operation through MCP.

## Regression validation

Reported results on the project host, communicated on 2026-11-03 at 21:25 UTC:

- Six consecutive complete WSL runs, each passing 60/60 tests.
- An integrated-project run passing 60/60 after both patches were applied to `/path/to/qnx-mcp`.
- Continued successful real SDK compilation after patch validation.
- A pre-integration backup at `/path/to/validation/qnx-mcp-antes-parches-20261103.tgz`.

Underlying suite logs were not inspected in this documentation update. The inspected compiler report is timestamped 20:25 UTC and does not independently establish which patch revision was compiled.

Separately, the isolated second candidate previously produced an observed Linux result of 60 passes, zero failures, zero cancellations and zero skips. Its recorded log is `/path/to/validation/wsl-observation-candidate-yqkwxjb9/complete-validation.log`. Regression tests use simulated executables, controlled Linux processes and supplied socket tables. Guest execution is supported by the separate console evidence, rather than those regression tests.

## Remaining provenance and delivery work

- Associate compilation and guest evidence with the exact source revision and retain or link the source input.
- Preserve the distinction between inspected evidence and reported regression outcomes. Document SDK prerequisites without publishing restricted material or credentials.
- Publish the repository and reviewed evidence with LICENSE visible.
- Record and publish the video; verify playback and public links.
- Complete and submit the Devpost form.

Compilation and guest execution are completed evidence milestones. `DOCUMENTATION-UPDATES.md` is an earlier proposal predating the guest evidence; it does not define the current execution status. This documentation update did not install software, run QEMU or servers, create accounts or repeat tests.

Publication note: project and validation paths in this document use neutral placeholders. Consult the unchanged evidence files for original recorded paths.

# Real QNX compilation and guest execution

Real compilation through MCP and subsequent execution of the unchanged artifact inside QNX were completed on the project host. They are separate workflows: the compiler smoke does not execute artifacts, and the guest run did not use the MCP image tools.

## Prerequisites

Use Linux with Node.js 22 or later, the project dependencies and an existing licensed QNX SDP installation. The recorded environment used QNX SDP 8.0 on Ubuntu 24.04 under WSL2. Compiler output identifies GCC 12.2.0 and target `12.2.0,gcc_ntox86_64`; it does not establish an additional SDK patch release.

Load the installed SDK environment in the terminal used for compilation. This is an operator template, not a recorded installation path:

```bash
source /absolute/path/to/installed-sdp/qnxsdp-env.sh
```

Use the environment script and arguments appropriate to the installed SDK. Keep credentials and license material out of recordings and published reports.

## Compile through MCP

From the repository root, with the SDK environment loaded and project dependencies available:

```bash
npm run smoke
```

The client launches the MCP server, lists tools, requests compiler information, submits `examples/hello/src/hello.c` for compilation and polls operation status. Compilation uses the fixed target argument `-Vgcc_ntox86_64`. It does not call image tools.

The command prints the generated evidence directory. Inspect its `report.json` and `report.md`: real mode, simulated=false, success=true, compiler identity and successful operation exit codes. The client independently verifies artifact size and SHA-256. Compiler arguments in reports are reconstructed from the executor contract, rather than a server-provided execution trace.

A successful artifact remains at `examples/hello/build/<operationId>/program`. The retained run produced a 9208-byte executable with interpreter `/usr/lib/ldqnx-64.so.2` and SHA-256:

```text
e5596d9e949d480cf1c129c6dbcd98adec84661edad263e40af204991dc6e798
```

See the retained [JSON report](../evidence/2026-11-03T20-25-05.120Z-q4xWZQ/report.json), [Markdown report](../evidence/2026-11-03T20-25-05.120Z-q4xWZQ/report.md) and [host metadata](../evidence/host-facts.txt). Those report formats describe one compilation run. Exact compiled source-commit provenance remains unestablished.

## Reproduce the separate SDK/QEMU workflow

Use [the retained execution README](../evidence/qemu-run-20261103/README.md) together with its image snippets and launcher. The retained files contain original host paths; prepare working copies with paths appropriate to the reproduction environment. Preserve the published evidence originals.

1. Compile the example through MCP and select the successful artifact from that run. Record its size and hash.
2. Create an x86_64 image using the installed SDK's `mkqnximage --type=qemu --arch=x86_64 --graphics=no`, following that installation's image creation and rebuild procedure.
3. In the image workspace, adapt the retained `ifs_files.custom` and `post_start.custom` snippets. Place the selected artifact at `/proc/boot/automata-hello`, preserving its bytes. The startup snippet prints the run marker, invokes the program and prints its exit status. Rebuild the image with those snippets.
4. Review and adapt a working copy of `run-qemu.sh`. Its original working directory is host-specific. The retained launcher uses the generated disk and IFS files, serial output to a file and `-nic none`; it waits for the exit marker and terminates QEMU afterward.
5. Run that reviewed launcher in the prepared image workspace. Retain the complete console and hashes for this new run, separately from the existing evidence.

The retained run used QEMU 8.2.2 with TCG and `-cpu max`, without a KVM device. Its console records:

```text
QNX_MCP_RUN_BEGIN
QNX noname 8.0.0 2026/06/05-16:26:03EDT x86pc x86_64
Hello from QNX MCP smoke.
QNX_MCP_RUN_EXIT=0
```

Compare the selected compilation artifact with the file incorporated into the image. A new build need not have the historical hash; record the identity of the artifact actually used.

## Limits

- The recorded guest had no network interface. Its console records networking warnings and an sshd startup failure with `Memory fault (core dumped)`, followed by successful execution of the example. Networking and SSH were not validated.
- SDK image tools placed the artifact. The MCP server did not transfer it.
- All four MCP image lifecycle tools remain blocked with `UNSAFE_CONFIGURATION`. The separate guest run does not validate or activate them.
- No login was performed; execution relied on the startup snippet.
- These results do not establish host isolation.

## Simulated rehearsal

```bash
npm run smoke:fake
```

Fake mode uses simulated executables and diagnostic output. It demonstrates neither real QNX compilation nor guest execution. Label it explicitly when recording.

This documentation update did not install software, execute compilation or QEMU, launch servers, create accounts or alter retained evidence.

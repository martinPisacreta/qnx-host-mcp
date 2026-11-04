# QNX 8.0 guest execution of the MCP-compiled artifact (2026-11-03)

This directory records the first execution of the program compiled through QNX Host MCP inside a QNX SDP 8.0 x86_64 guest running in QEMU, on the project host (Ubuntu 24.04 on WSL2, kernel 6.6.87.2-microsoft-standard-WSL2, QEMU 8.2.2 from the Ubuntu archive).

## What ran

- Artifact: `examples/hello/build/0279c855d511a150ba531331739c259b/program`, the output of the real smoke run in `../2026-11-03T20-25-05.120Z-q4xWZQ/`. SHA-256 `e5596d9e949d480cf1c129c6dbcd98adec84661edad263e40af204991dc6e798`, 9208 bytes. Three independent compilations produced the same hash.
- Source: `examples/hello/src/hello.c`, which prints `Hello from QNX MCP smoke.` and returns 0.
- Guest image: built with the SDK's `mkqnximage --type=qemu --arch=x86_64 --graphics=no` from `/root/qnx800/target/qnx`, then rebuilt with the two snippets in this directory. `ifs_files.custom` places the unchanged artifact at `/proc/boot/automata-hello`; `post_start.custom` runs it at the end of startup and prints its exit status. SHA-256 of the resulting `ifs.bin` is in `sha256.txt`.
- Boot: `run-qemu.sh` starts QEMU with TCG (`-cpu max`, no KVM device was available), no network interface and the serial console written to a file, waits for the exit marker and stops QEMU with SIGTERM.

## Result

From `qemu-serial-console.txt`:

```
QNX_MCP_RUN_BEGIN
QNX noname 8.0.0 2026/06/05-16:26:03EDT x86pc x86_64
Hello from QNX MCP smoke.
QNX_MCP_RUN_EXIT=0
```

The guest identified itself as QNX 8.0.0 x86_64, the artifact printed its expected line and exited with status 0.

## Notes and limits

- The guest was started without a network interface, so the networking step reports no interfaces and the image's sshd start fails with a memory fault. Neither involves the artifact; they are recorded unedited in the console log.
- The artifact was placed in the image by the SDK image tools, not transferred by the MCP server. The MCP image lifecycle tools remain gated, as documented in the main README.
- No login was performed. The run relies only on the startup snippet.

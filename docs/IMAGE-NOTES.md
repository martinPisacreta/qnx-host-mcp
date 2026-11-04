# Image lifecycle: implementation and official evidence

## Current implementation evidence

The latest fully observed combined validation recorded 55 tests passed, 0 failed, 0 cancelled and 0 skipped. The final run after the documentation update confirmed 55 passed, 0 failed, 0 cancelled and 0 skipped (exit code 0). Tests use controlled Linux processes, fake executables and supplied socket tables; no licensed QNX SDK or real image was executed.

Internal start retains a persistent launcher with private stdin and bounded output, reads `output/qemu.pid`, and checks the target against captured Linux process identities and ancestry. Without an injected observer, socket observation uses procfs.

Stop checks ownership before invoking the fixed `--stop` command. Cleanup observes removal of the captured target and launcher and can fall back to signalling the captured launcher group after identity checks. Unconfirmed cleanup returns `CANCEL_FAILED`.

Coverage includes startup cancellation, process removal before releasing the operation lock, executor shutdown, and rejection of altered launcher identities. The startup identity rejection test observes zero `process.kill` calls during rejection. These tests do not reproduce actual PID reuse.

All four MCP image tools remain blocked with `UNSAFE_CONFIGURATION`, including when configuration requests `enabled=true`.

## Official QSTI for QEMU evidence

### Bridge networking and host setup

[Additional specifications — QSTI for QEMU](https://www.qnx.com/developers/docs/qnxeverywhere/com.qnx.doc.target_images/topic/qsti_qemu/additional_specs.html) includes this literal command fragment:

> `-netdev bridge,br=virbr0,id=net0`

This documents bridge networking through `virbr0` in the published QNX Developer Desktop command. It does not establish that every mkqnximage configuration uses that backend.

[Getting started — QSTI for QEMU](https://www.qnx.com/developers/docs/qnxeverywhere/com.qnx.doc.target_images/topic/qsti_qemu/getting_started.html) includes the bridge configuration text:

> `allow virbr0`

The surrounding setup commands use `sudo` to create directories, write the bridge configuration and create its link. The Additional specifications launch example also begins with `sudo qemu-system-x86_64`. These are documented privileged examples; they do not establish which privileges are necessary for every host configuration. No privileged command was executed for this work.

### Serial console and PID file

[Additional specifications](https://www.qnx.com/developers/docs/qnxeverywhere/com.qnx.doc.target_images/topic/qsti_qemu/additional_specs.html) includes both literal command fragments:

> `-serial mon:stdio`

> `-pidfile output/qemu.pid`

[Getting started](https://www.qnx.com/developers/docs/qnxeverywhere/com.qnx.doc.target_images/topic/qsti_qemu/getting_started.html) states:

> The terminal used to start QEMU becomes a serial console.

These passages document console attachment and the PID-file path for the shown launch command. They support keeping MCP input separate from guest console input. They do not prove that the executor's persistent parent/child launcher model matches an actual mkqnximage installation.

### IP lookup and stopping

[Getting started](https://www.qnx.com/developers/docs/qnxeverywhere/com.qnx.doc.target_images/topic/qsti_qemu/getting_started.html) instructs users to run `mkqnximage --getip`:

> from a different terminal from within the same runtime folder

The same page instructs users to execute `mkqnximage --stop` in another terminal within that runtime folder. It also describes obtaining the guest IP through `ifconfig` in the serial console or reading it from the display.

This documents the runtime-folder workflow for IP lookup and stop. It does not establish verified process ownership or guarantee the stopping scope of a persisted configuration.

## A VERIFICAR: questions not established by the cited passages

- Whether SSH forwarding can specify a host address and port, and whether any forwarding defaults exclusively to loopback. The bridge example supplies no such guarantee.
- Whether a specific installation uses TAP, user networking or forwarding in addition to the documented bridge example.
- The minimum host privileges for the intended installation and whether execution can safely avoid privileged launch commands.
- Actual mkqnximage launcher lifetime, ancestry, PID-file behavior, PID reuse handling and stop scope across persisted configurations.
- Host filesystem isolation, descendant and protocol coverage, and continuous network enforcement. The current observation is a point-in-time TCP check.

## Review boundary

The cited official instructions resolve the previously undocumented bridge, console, PID-file and runtime-folder workflow. Real QNX compatibility and host isolation remain unverified deployment limitations. Completing this documentation tranche does not authorize enabling the MCP image tools.

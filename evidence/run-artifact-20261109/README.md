# qnx_run_artifact with the real SDK and QEMU (9 November 2026)

`qnx_run_artifact` runs an artifact produced by `qnx_compile_c` in a private QEMU image with no emulated network adapter. It is disabled unless the operator supplies `QNX_MCP_RUN_CONFIG`.

[run-output.txt](run-output.txt) is the unedited output of `scripts/run-example.mjs`, run from this repository's files on Windows 11 with WSL2 Ubuntu 24.04, QNX SDP 8.0 (qcc 12.2.0, gcc_ntox86_64) and QEMU 8.2.2:

| Case | Result |
| --- | --- |
| No `QNX_MCP_RUN_CONFIG` | Compilation succeeded; `qnx_run_artifact` failed with `UNSAFE_CONFIGURATION` and started nothing |
| `examples/hello` | Guest exit status 0, `Hello from QNX MCP smoke.`; build about 2.1 s, guest about 21.7 s, total about 23.9 s |
| `examples/nameservice` | Guest exit status 0, `QNX_NAME_OK replies=21,33,63` and `cross_process=1 registered=1`; total about 23.6 s |
| Afterwards | No QEMU process left; both `runs/` directories empty |

How it was configured: the template directory contained only the tutorial's mkqnximage `local/` configuration (no `output/`, no binaries). The run configuration was `{ "version": 1, "enabled": true, "templateDir": "<absolute template path>" }`. The SDK environment (`qnxsdp-env.sh`) was loaded before starting the server.

The console lines before the markers (`no valid interfaces found`, an sshd memory fault) come from the image's own startup without a network interface, as in the earlier recorded runs. The nameservice SHA-256 (`f7100afb…`) matches the binary recorded in [qemu-run-name-20261109](../qemu-run-name-20261109/README.md).

Limits: QEMU TCG emulation is not a real-time measurement; `-nic none` removes the emulated network adapter but does not by itself isolate the host; the exit status comes from a console marker written by the guest, so it is evidence for cooperative programs, not an attestation for hostile ones.

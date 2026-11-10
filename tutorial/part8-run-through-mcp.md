# Part 8: Compile and run a QNX program through MCP

Continue from [Part 7](part7-name-service.md): let an MCP client compile and run the program.
Previously, the tutorial added the binary to an image using SDK tools; now the client calls `qnx_compile_c`, then `qnx_run_artifact`.
The run tool accepts the successful compilation's `compileOperationId`; use `qnx_operation_status` to poll completion.
The [recorded evidence](../evidence/run-artifact-20261109/README.md) covers real SDK/QEMU runs on 9 November 2026.

## Prepare the operator configuration

Use the existing licensed SDK environment and dependencies from Part 1.
Prepare an absolute template directory containing only the tutorial's mkqnximage `local/` configuration, with no `output/` directory or binaries.
Set `QNX_MCP_RUN_CONFIG` to the absolute path of a JSON file with this structure, replacing the template path:
```json
{ "version": 1, "enabled": true, "templateDir": "/absolute/path/to/prepared-template" }
```
Load `qnxsdp-env.sh` before starting the server; the client must pass the configuration to its server process.
See the [run configuration](../README.md#qnx_run_artifact-disabled-by-default) and [recorded setup](../evidence/run-artifact-20261109/README.md).

## Compile and run hello

From the repository root in the prepared environment:
```bash
node scripts/run-example.mjs examples/hello src/hello.c
```
Part 2 of [run-output.txt](../evidence/run-artifact-20261109/run-output.txt) records this output verbatim:
```text
{
  "source": "src/hello.c",
  "compile": {
    "state": "succeeded",
    "sizeBytes": 9208,
    "sha256": "e5596d9e949d480cf1c129c6dbcd98adec84661edad263e40af204991dc6e798"
  },
  "run": {
    "state": "succeeded",
    "errorCode": null,
    "exitCode": 0,
    "buildExitCode": 0,
    "qemuExitCode": 0,
    "timings": {
      "preparationMs": 31,
      "buildMs": 2116,
      "guestMs": 21742,
      "cleanupMs": 44,
      "totalMs": 23933
    },
    "consoleTruncated": false
  },
  "consoleTail": [
    "ifconfig: interface vtnet0 does not exist",
    "no valid interfaces found",
    "---> Starting sshd",
    "Memory fault (core dumped) ",
    "---> Starting misc",
    "QNX_RUN_d9ecc1ddd380a62757e05bc25d793614_BEGIN",
    "Hello from QNX MCP smoke.",
    "QNX_RUN_d9ecc1ddd380a62757e05bc25d793614_EXIT=0"
  ]
}
exit status: 0
```

## Run the name service example

Use the same operator configuration:
```bash
node scripts/run-example.mjs examples/nameservice src/nameservice.c
```
Part 3 of the same evidence records this output verbatim:
```text
{
  "source": "src/nameservice.c",
  "compile": {
    "state": "succeeded",
    "sizeBytes": 14224,
    "sha256": "f7100afb90f394ef7ebaa57c5c704be94a242d14061c06ca944fd7a2666a386d"
  },
  "run": {
    "state": "succeeded",
    "errorCode": null,
    "exitCode": 0,
    "buildExitCode": 0,
    "qemuExitCode": 0,
    "timings": {
      "preparationMs": 25,
      "buildMs": 1705,
      "guestMs": 21831,
      "cleanupMs": 46,
      "totalMs": 23608
    },
    "consoleTruncated": false
  },
  "consoleTail": [
    "no valid interfaces found",
    "---> Starting sshd",
    "Memory fault (core dumped) ",
    "---> Starting misc",
    "QNX_RUN_ad25d9d1e9afa34bcfe22f490581cd06_BEGIN",
    "QNX_NAME_OK replies=21,33,63",
    "cross_process=1 registered=1",
    "QNX_RUN_ad25d9d1e9afa34bcfe22f490581cd06_EXIT=0"
  ]
}
exit status: 0
```

## Read the result and limits

`state` describes each operation's result; `exitCode` reports the guest program's status, while `buildExitCode` and `qemuExitCode` report the builder and emulator statuses separately.
`timings` records preparation, build, guest, cleanup and total durations in milliseconds; `consoleTruncated: false` reports that console retention was not truncated.
The `QNX_RUN_<nonce>_BEGIN` and `QNX_RUN_<nonce>_EXIT=0` lines delimit the run and report its guest exit status; each recorded run has its own nonce.
Without `QNX_MCP_RUN_CONFIG`, evidence Part 1 shows compilation succeeded but run failed with `UNSAFE_CONFIGURATION`, null exit codes and timings, an empty console tail and client exit status 1; nothing started.
The earlier network and sshd messages come from image startup without a network interface, as documented in the evidence.
QEMU TCG emulation is not a real-time measurement; `-nic none` removes the emulated network adapter but does not by itself isolate the host.
The exit status comes from a console marker written by the guest, so it is evidence for cooperative programs, not an attestation for hostile ones.
The evidence also records no QEMU process left and both example `runs/` directories empty afterwards.

[Previous: Part 7](part7-name-service.md)

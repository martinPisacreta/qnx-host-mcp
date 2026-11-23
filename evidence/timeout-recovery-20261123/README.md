# A program that never exits, then a normal run: recorded on 23 November 2026

Fresh clone of revision `5691362cf7cced4e4f099c565c1d2696b2b572d5`, `npm ci`, QNX SDP 8.0 environment loaded, `QNX_MCP_RUN_CONFIG` enabled with the tutorial's image template, Node.js v22.23.3 ([revision.txt](revision.txt), [host.txt](host.txt)).

| File | What it is |
| --- | --- |
| [stuck.c](stuck.c) | Prints one line, then sleeps in a loop forever |
| [step1-output.txt](step1-output.txt) | `node scripts/run-example.mjs examples/stuck src/stuck.c`: compile succeeded; run state `timed_out`, error code `TIMEOUT`, guest exit code `null`, guest time 60,006 ms, cleanup 44 ms; the console shows the program's line; QEMU was terminated by the server |
| [step2-output.txt](step2-output.txt) | `node scripts/run-example.mjs examples/hello src/hello.c` right after: run `succeeded`, guest exit code 0 |
| [processes.txt](processes.txt) | `qemu-system` processes in the Linux host before, after step 1 and after step 2: 0 each time |

The 60-second guest deadline is the one documented in the [README](../../README.md#mcp-tools); nothing was changed in the server for this recording. The published files are the outputs as produced; no paths of the clone appear in them.

The console lines before the program's own output (`if_up: tries exhausted`, `Memory fault (core dumped)` while starting sshd) come from the boot of the template image, which has no network adapter by design; they appear in every run, including the successful one.

Limits: one run of each step on one host (WSL 2). It shows that a guest program which does not finish is stopped at the deadline and that the next run works; it does not measure behaviour under load or with several concurrent runs.

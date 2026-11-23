# Example: a program that never exits

`src/stuck.c` prints one line and then sleeps in a loop forever. Running it with `qnx_run_artifact` shows the guest deadline at work: after 60 seconds the server stops QEMU and returns run state `timed_out` with error code `TIMEOUT`, and the console tail still contains the line the program printed. A normal run right after works as usual ([evidence](../../evidence/timeout-recovery-20261123/README.md)).

```bash
node scripts/run-example.mjs examples/stuck src/stuck.c
```

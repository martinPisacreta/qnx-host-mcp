# Diagnose, fix and run: recorded on 23 November 2026

Fresh clone of revision `ac77688756ac1f8b12f94cf9f6c9805df165c895`, `npm ci`, QNX SDP 8.0 environment loaded, `QNX_MCP_RUN_CONFIG` enabled with the tutorial's image template, Node.js v22.23.3 ([host.txt](host.txt)).

| File | What it is |
| --- | --- |
| [channel-broken.c](channel-broken.c) | Source with the misspelled flag `_NTO_CHF_DISCONECT` |
| [step1-output.txt](step1-output.txt) | `node scripts/run-example.mjs examples/walkthrough src/channel.c` with the broken source: compile error at 7:30, exit status 1, nothing booted |
| [fix.diff](fix.diff) | The one-line fix |
| [step2-output.txt](step2-output.txt) | Same command with the fixed source: compile succeeded, run succeeded, guest exit code 0, console with the program's two lines |

Published copies: the clone's absolute path was removed from compiler messages, and the run's timing fields were replaced with "removed from this published copy". Nothing else was edited.

Limits: one run of each step on one host; the compiler diagnostic is GCC's own output passed through by the server.

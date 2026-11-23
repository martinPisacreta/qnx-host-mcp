# Part 9: Diagnose a compile error, fix it and run the program

Continue from [Part 8](part8-run-through-mcp.md): this part shows what a client gets back when generated QNX code does not compile, and that the corrected program then runs on QNX in QEMU.
Both steps use the same operator configuration as Part 8 and were recorded on 23 November 2026 from a fresh clone of revision `ac77688` ([evidence](../evidence/diagnose-fix-20261123/README.md)).

## Step 1: a misspelled QNX constant

[`channel-broken.c`](../evidence/diagnose-fix-20261123/channel-broken.c) creates a channel with `ChannelCreate`, but the flag is misspelled as `_NTO_CHF_DISCONECT`, the kind of slip an assistant can make when it writes QNX code from memory.
It was placed at `examples/walkthrough/src/channel.c` and run with:

```bash
node scripts/run-example.mjs examples/walkthrough src/channel.c
```

The compile request fails, nothing is booted, and the compiler's own diagnostic comes back with the file, line and column ([step1-output.txt](../evidence/diagnose-fix-20261123/step1-output.txt)):

```text
run-example: The tool returned a nonzero status or terminated by signal.
examples/walkthrough/src/channel.c: In function 'main':
examples/walkthrough/src/channel.c:7:30: error: '_NTO_CHF_DISCONECT' undeclared (first use in this function)
    7 |     int chid = ChannelCreate(_NTO_CHF_DISCONECT);
      |                              ^~~~~~~~~~~~~~~~~~
examples/walkthrough/src/channel.c:7:30: note: each undeclared identifier is reported only once for each function it appears in
run-example: Compile COMMAND_FAILED (exit 1)
exit status: 1
```

## Step 2: fix and run

The fix is one identifier, `_NTO_CHF_DISCONNECT` from `<sys/neutrino.h>` ([fix.diff](../evidence/diagnose-fix-20261123/fix.diff)); the corrected file is [`examples/walkthrough/src/channel.c`](../examples/walkthrough/src/channel.c).
The same command now compiles the program, builds a private image, boots it in QEMU without networking and returns the guest's console and exit status ([step2-output.txt](../evidence/diagnose-fix-20261123/step2-output.txt), timing fields removed from the published copy):

```text
  "run": {
    "state": "succeeded",
    "errorCode": null,
    "exitCode": 0,
    ...
  "consoleTail": [
    ...
    "QNX_RUN_b5508da14a1a3c31882f9791b3b374e4_BEGIN",
    "Channel created: chid=1",
    "Walkthrough program finished.",
    "QNX_RUN_b5508da14a1a3c31882f9791b3b374e4_EXIT=0"
  ]
```

## Limits

One recorded run of each step, on the same host as the earlier evidence (QNX SDP 8.0 under WSL2, QEMU 8.2.2).
The console tail also shows the image's usual network-interface and `sshd` startup messages, the same as in Part 8's evidence; they come from the image's own startup with no network adapter, not from this program.
The diagnostic is GCC's; the server does not suggest the fix, the client or developer does.

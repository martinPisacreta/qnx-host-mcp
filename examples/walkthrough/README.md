# Walkthrough example: create and destroy a channel

`src/channel.c` creates a QNX channel with `ChannelCreate(_NTO_CHF_DISCONNECT)`, prints its ID and destroys it with `ChannelDestroy`.
It is the corrected program from [Tutorial Part 9](../../tutorial/part9-diagnose-and-fix.md), which first shows the compile error returned for a misspelled flag and then this file running on QNX 8.0 in QEMU with exit status 0 ([evidence](../../evidence/diagnose-fix-20261123/README.md)).

```bash
node scripts/run-example.mjs examples/walkthrough src/channel.c
```

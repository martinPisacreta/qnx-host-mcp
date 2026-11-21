# Seven examples rebuilt and run from an identified public revision (2026-11-21)

The earlier evidence folders were produced from a working copy before publication and do not record the source revision they were compiled from. This folder closes that gap for one run: the seven examples were compiled and executed again from a fresh clone of the public repository at a pinned revision.

## What was done

On 21 November 2026, on the project host (Ubuntu 24.04 on WSL2, QNX SDP 8.0, QEMU 8.2.2 from the Ubuntu archive), [reproduce.sh](reproduce.sh):

1. cloned `https://github.com/martinPisacreta/qnx-host-mcp` and checked out revision `f9b3260fcd31afb571cb0835aac85bae7f6926bb` (the head of `main` before this folder was added), with no working-tree changes;
2. compiled the seven example sources with `qcc -Vgcc_ntox86_64 -Wall` (each returned 0 with no warnings);
3. created a new image in an empty directory with `mkqnximage --type=qemu --arch=x86_64 --graphics=no --noprompt`, added the seven executables with [ifs_files.custom](ifs_files.custom) and ran them at the end of startup with [post_start.custom](post_start.custom);
4. booted that image in QEMU with no network and the serial console written to a file;
5. ran `tutorial/check-run.sh` from the same clone against that console.

## Result

From [report.txt](report.txt), which also lists the SHA-256 of every source and every executable:

```
PASS hello
PASS msgpass
PASS resmgr
PASS pulses
PASS events
PASS prioinherit
PASS nameservice
7/7 examples passed
check-run exit status: 0
```

The console of that boot is [qemu-serial-console.txt](qemu-serial-console.txt) (carriage returns removed). It can be checked again without an SDK: `bash tutorial/check-run.sh evidence/repro-f9b3260-20261121/qemu-serial-console.txt`.

## Limits

- One run, on the same host as the earlier evidence. It was not repeated on another machine.
- The executables were built with qcc directly. This run did not compile through the MCP server; that path is covered by the earlier folders and by `npm run smoke`.
- As in the earlier boots, the guest had no network interface and the image's sshd startup reported a memory fault; no login was performed.
- This run identifies the revision for itself only. It does not establish which revision the earlier evidence folders were compiled from.
- The published [reproduce.sh](reproduce.sh) is the script that ran, with its usage comment and its output folder replaced by neutral values.

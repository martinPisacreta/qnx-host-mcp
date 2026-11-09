# Run a QNX 8.0 C program in QEMU from Windows

This is Part 1. [Part 2](part2-message-passing.md) adds native QNX message passing (`MsgSend`, `MsgReceive`, `MsgReply`) to the same image, [Part 3](part3-resource-manager.md) adds a resource manager read with ordinary `open` and `read`, [Part 4](part4-pulses-timers.md) adds a periodic timer that delivers pulses to a channel, [Part 5](part5-registered-events.md) adds a server that replies at once and notifies the client later with a registered event, [Part 6](part6-priority-inheritance.md) shows a server thread running at the priority of the client it serves, and [Part 7](part7-name-service.md) moves the client into a separate process that finds the server by name; Parts 1 to 5 were verified on 6 November 2026, Part 6 on 8 November 2026 and Part 7 on 9 November 2026.

## What you will achieve

Compile a C program for QNX 8.0 using Ubuntu under WSL2 on Windows. Build a custom image and run the program automatically inside QEMU. Capture its output in a file without physical hardware or a guest login. The guest has no network interface; installation requires Internet access.

Compilation, image creation and guest execution were verified on 6 November 2026 at 01:59 UTC. The verification host used Windows 11, WSL2 and Ubuntu 24.04.5 LTS. Its kernel was `6.6.87.2-microsoft-standard-WSL2`. Installation instructions below come from the earlier successful installation records.

## Requirements

- Windows 11 with WSL2 and Ubuntu 24.04.
- A myQNX account and an activated free noncommercial QNX SDP 8.0 license.
- QNX Software Center for Linux, including its command-line client.
- Internet access for installation and sufficient free disk space.
- An Ubuntu root shell, matching the recorded paths under `/root`.

For prerequisites outside the verified command sequence, use official guidance:

- [Install WSL and Ubuntu: Microsoft documentation](https://learn.microsoft.com/en-us/windows/wsl/install).
- [QNX Software Center: QNX documentation](https://www.qnx.com/developers/docs/8.0/).
- [Create or access a myQNX account](https://www.qnx.com/account/).

Check the current noncommercial license terms through QNX before installation. The verified SDK directory, including the QEMU quickstart package, occupied 11 GB. The generated image working directory occupied approximately 170 MB. These are observed sizes, not a total free-space requirement for installation. Allow additional space for downloads, temporary files and subsequent builds. The official quickstart archive can expand to a 48 GB non-sparse disk. This walkthrough builds a custom image rather than extracting that disk.

Run shell commands inside Ubuntu. Save multiline blocks as Bash scripts if needed. The original notes warn about variable expansion through PowerShell wrappers.

## 1. Locate QNX Software Center

The verified command-line executable was:

```text
/root/qnx/qnxsoftwarecenter/qnxsoftwarecenter/qnxsoftwarecenter_clt
```

Use that complete path; the earlier notes omitted one directory component. If Software Center is installed elsewhere, adjust `Q` accordingly.

## 2. Activate the license and install SDP 8.0

The following operations reproduce the recorded installation sequence. Replace the email placeholder locally and enter the password interactively. Do not enable shell tracing or share credential-bearing process listings.

```bash
Q=/root/qnx/qnxsoftwarecenter/qnxsoftwarecenter/qnxsoftwarecenter_clt
U='<your-myqnx-email>'
read -r -s -p 'myQNX password: ' QNXPW
printf '\n'
A=(-myqnx.user "$U" -myqnx.password "$QNXPW")
```

Run each operation separately and check its result before proceeding:

```bash
"$Q" "${A[@]}" -syncLicenseKeys -activateAll -listLicenseKeys
"$Q" "${A[@]}" -mirrorBaseline qnx800
"$Q" "${A[@]}" -cleanInstall -destination /root/qnx800 -installBaseline com.qnx.qnx800
"$Q" "${A[@]}" -destination /root/qnx800 -installPackage com.qnx.qnx800.quickstart.qemu
unset QNXPW A
```

Omitting `-activateAll` prevented installation in the original recorded attempt. Do not extract the quickstart disk for the custom-image steps below. Load the SDK environment in every new build shell:

```bash
source /root/qnx800/qnxsdp-env.sh
```

## 3. Install QEMU

These package names and options come from the recorded Ubuntu installation script:

```bash
apt-get update -qq
apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils
qemu-system-x86_64 --version
```

The verification reported:

```text
QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.18)
```

There was no `/dev/kvm` device. QEMU used TCG with `-cpu max`.

## 4. Compile a C program with qcc

Keep source files separate from the initially empty image directory. The verification used `/root/qnx-tutorial-src` and `/root/qnx-tutorial-run`. Create the source directory and save the following as `hello.c` inside it:

```bash
mkdir /root/qnx-tutorial-src
cd /root/qnx-tutorial-src
```

```c
#include <stdio.h>

int main(void)
{
    puts("Hello from QNX MCP smoke.");
    return 0;
}
```

Compile and inspect the executable:

```bash
source /root/qnx800/qnxsdp-env.sh
qcc -Vgcc_ntox86_64 -o hello hello.c
file hello
```

This exact source and qcc command compiled successfully with return code 0. The verified qcc executable was `/root/qnx800/host/linux/x86_64/usr/bin/qcc`. Its target list included `12.2.0,gcc_ntox86_64` as the default. The verification recorded this `file` result with the BuildID abbreviated:

```text
hello: ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /usr/lib/ldqnx-64.so.2, BuildID[md5/uuid]=…, with debug_info, not stripped
```

The QNX interpreter path is the key distinction from a host Linux executable.

## 5. Build the custom image

The initial `mkqnximage` command requires a completely empty directory. Even a log file in that directory caused the verified first attempt to fail. Create the image before copying the executable or creating other files there:

```bash
mkdir /root/qnx-tutorial-run
cd /root/qnx-tutorial-run
source /root/qnx800/qnxsdp-env.sh
mkqnximage --type=qemu --arch=x86_64 --graphics=no --noprompt
```

If the directory already exists, preserve its contents and choose a fresh directory. Update subsequent paths consistently if you choose another location. The successful command returned 0 and generated these snippet templates:

```text
local/snippets/data_files.custom
local/snippets/ifs_files.custom
local/snippets/ifs_start.custom
local/snippets/post_start.custom
local/snippets/profile.custom
local/snippets/system_files.custom
```

Now copy the executable into the generated image directory:

```bash
cp /root/qnx-tutorial-src/hello /root/qnx-tutorial-run/automata-hello
```

Append this line to the generated `local/snippets/ifs_files.custom`:

```text
[perms=0755] automata-hello=/root/qnx-tutorial-run/automata-hello
```

Append these lines to `local/snippets/post_start.custom`:

```sh
echo "QNX_MCP_RUN_BEGIN"
uname -a
/proc/boot/automata-hello
echo "QNX_MCP_RUN_EXIT=$?"
```

The executable becomes `/proc/boot/automata-hello` inside the guest. The startup hook runs it without a login; keep the status echo immediately after it. Rebuild from `/root/qnx-tutorial-run`:

```bash
mkqnximage --noprompt --build
```

The verified rebuild returned 0. `output/ifs.bin` was approximately 10.9 MB. `output/disk-qemu.vmdk` was a 169-byte descriptor, not the total disk-image size. The complete image working directory occupied approximately 170 MB.

## 6. Boot without networking and capture the console

Run this block as one Bash script (it is also saved as [`run-qemu.sh`](run-qemu.sh)). Preserve previous console output first. The early-exit check was also tested during verification.

```bash
cd /root/qnx-tutorial-run
rm -f output/qemu.out
qemu-system-x86_64 -smp 2 -cpu max -m 1G \
  -drive file=output/disk-qemu.vmdk,if=ide,id=drv0 \
  -kernel output/ifs.bin -display none -monitor none -nic none \
  -serial file:output/qemu.out -pidfile output/qemu.pid \
  -object rng-random,filename=/dev/urandom,id=rng0 -device virtio-rng-pci,rng=rng0 &
QPID=$!
for i in $(seq 1 90); do
  sleep 4
  if grep -q 'QNX_MCP_RUN_EXIT' output/qemu.out 2>/dev/null; then break; fi
  if ! kill -0 "$QPID" 2>/dev/null; then echo "QEMU exited early"; break; fi
done
sleep 3
kill -TERM "$QPID" 2>/dev/null
wait "$QPID" 2>/dev/null
tr -d '\r' < output/qemu.out | tail -40
```

`-nic none` removes networking; `-display none` disables the display. The serial console goes to `output/qemu.out`. The marker appeared after 24 seconds. The loop allows approximately six minutes but stops early if QEMU has exited. After the marker, the script waits three seconds and sends SIGTERM to its QEMU process. The verified shutdown reported `terminating on signal 15`.

## 7. Read the output

The verified guest printed:

```text
QNX_MCP_RUN_BEGIN
QNX noname 8.0.0 2026/06/05-16:26:03EDT x86pc x86_64
Hello from QNX MCP smoke.
QNX_MCP_RUN_EXIT=0
```

Check the greeting and the guest program's exit status in your own console file. QEMU's termination status is separate from `QNX_MCP_RUN_EXIT=0`. The earlier historical console also recorded missing interfaces and an sshd memory fault. Those startup messages did not prevent the demonstrated program from running.

### Check all seven examples in one command

When the image also carries the examples of Parts 2 to 7, one boot runs all seven. From the repository root, check that boot's console file:

```bash
bash tutorial/check-run.sh /root/qnx-tutorial-run/output/qemu.out
```

[`check-run.sh`](check-run.sh) removes carriage returns, requires every line of each `examples/<example>/expected-output.txt` as a complete console line plus the example's exit marker with status 0, and prints `PASS` or `FAIL` per example. It exits with 0 only when all seven pass. It reads an existing console file; it does not start QEMU or rerun anything. The result of a fresh boot on 9 November 2026 is in [`verification-all-2026-11-09.txt`](verification-all-2026-11-09.txt): `7/7 examples passed`.

## Common problems and cleanup

- **Installation fails:** check activation; the recorded sequence required `-activateAll`.
- **Build tools missing:** source `/root/qnx800/qnxsdp-env.sh` in the current shell.
- **Image initialization fails:** use an empty directory, without a binary or log file.
- **Guest asks for login:** check that you booted the custom image with the startup hook.
- **QEMU exits early:** inspect launch errors and confirm the image build succeeded.
- **No program marker:** check the snippets, executable mapping and rebuild result.
- **No KVM:** retain the tested TCG launch options.

The launcher stops and waits for the QEMU process it started. Preserve `output/qemu.out` before rerunning or removing generated artifacts. After QEMU stops, the two tutorial working directories are disposable build artifacts. Keep `/root/qnx800`, Software Center and license files for future builds. If credential entry was interrupted, clear its shell variables with `unset QNXPW A`.

## Files and evidence

- [`hello.c`](hello.c): the exact program compiled in step 4.
- [`run-qemu.sh`](run-qemu.sh): the boot and capture block from step 6, as one script.
- [`check-run.sh`](check-run.sh): checks a console file for the expected output and exit status of all seven examples.
- [`verification-all-2026-11-09.txt`](verification-all-2026-11-09.txt): checker output and serial console of a fresh boot with all seven examples on 9 November 2026.
- [`part2-message-passing.md`](part2-message-passing.md): Part 2, native QNX message passing between a client and a server thread.
- [`part3-resource-manager.md`](part3-resource-manager.md): Part 3, a resource manager at `/dev/automata-echo`, compiled directly and through MCP.
- [`part4-pulses-timers.md`](part4-pulses-timers.md): Part 4, a `CLOCK_MONOTONIC` timer that delivers pulses received with `MsgReceivePulse`, compiled directly and through MCP.
- [`part5-registered-events.md`](part5-registered-events.md): Part 5, `MsgRegisterEvent`, `MsgVerifyEvent` and `MsgDeliverEvent` between a client and a server thread, compiled directly and through MCP.
- [`part6-priority-inheritance.md`](part6-priority-inheritance.md): Part 6, message priority inheritance and `_NTO_CHF_FIXED_PRIORITY`, compiled directly and through MCP.
- [`part7-name-service.md`](part7-name-service.md): Part 7, `name_attach` and `name_open` between two processes, compiled directly and through MCP.
- [`verification-2026-11-06.txt`](verification-2026-11-06.txt): console output of the complete run of steps 4 to 7 on 6 November 2026 (Windows 11, WSL2, Ubuntu 24.04.5 LTS), including the guest output above.
- [`../evidence/qemu-run-20261103/`](../evidence/qemu-run-20261103/): the first recorded run of the same custom-image method, from this project's MCP smoke test on 3 November 2026.

The installation commands in step 2 reproduce the sequence that installed the SDK on 3 November 2026; they were not rerun on 6 November because the SDK was already installed.

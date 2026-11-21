#!/bin/bash
# Rebuilds and runs the seven examples from an identified public revision of this repository.
# It clones the public repository, pins the revision, compiles with qcc, builds a new image, boots QEMU and runs the check-run.sh of that clone.
# Run as root inside the Linux host that has the QNX SDP 8.0 at /root/qnx800: bash reproduce.sh
set -u
REV=f9b3260
W=/root/qnx-repro-20261121
OUT=${OUT:-/root/qnx-repro-out}   # the recorded run copied its results to a folder on the project host instead
rm -rf "$W"; mkdir -p "$W" "$OUT"
R="$W/report.txt"; : > "$R"
log() { echo "$@" | tee -a "$R"; }

log "== clone"
cd "$W" || exit 1
git clone -q https://github.com/martinPisacreta/qnx-host-mcp.git src 2>&1 | tail -2 | tee -a "$R"
[ -d src/.git ] || { log "CLONE FAILED"; cp "$R" "$OUT/"; exit 1; }
cd src && git checkout -q "$REV" 2>&1 | tee -a "$R"
log "revision: $(git rev-parse HEAD)"
log "revision date: $(git log -1 --format=%cI)"
log "working tree changes: $(git status --porcelain | wc -l)"

log "== toolchain"
source /root/qnx800/qnxsdp-env.sh >/dev/null
log "qcc: $(command -v qcc)"
log "QNX_TARGET: $QNX_TARGET"
qemu-system-x86_64 --version | head -1 | tee -a "$R"

log "== compile (qcc -Vgcc_ntox86_64 -Wall)"
B="$W/bin"; mkdir -p "$B"
comp() { # nombre-binario ruta-fuente
  local out
  out=$(qcc -Vgcc_ntox86_64 -Wall -o "$B/$1" "$2" 2>&1); local rc=$?
  log "$1 <- $2 rc=$rc warnings_or_errors_lines=$(printf '%s' "$out" | grep -c .)"
  [ -n "$out" ] && printf '%s\n' "$out" | head -5 | tee -a "$R"
  log "  source sha256 $(sha256sum "$2" | cut -c1-64)"
  [ -f "$B/$1" ] && log "  binary sha256 $(sha256sum "$B/$1" | cut -c1-64) $(file -b "$B/$1" | cut -c1-70)"
  return $rc
}
FAILC=0
comp automata-hello   examples/hello/src/hello.c             || FAILC=1
comp automata-msgpass examples/msgpass/src/msgpass.c         || FAILC=1
comp automata-resmgr  examples/resmgr/src/resmgr.c           || FAILC=1
comp automata-pulses  examples/pulses/src/pulses.c           || FAILC=1
comp automata-events  examples/events/src/events.c           || FAILC=1
comp automata-prio    examples/prioinherit/src/prioinherit.c || FAILC=1
comp automata-name    examples/nameservice/src/nameservice.c || FAILC=1
[ "$FAILC" = 0 ] || { log "COMPILE FAILED"; cp "$R" "$OUT/"; exit 1; }

log "== image (new empty directory)"
D="$W/image"; mkdir -p "$D"; cd "$D" || exit 1
mkqnximage --type=qemu --arch=x86_64 --graphics=no --noprompt > "$W/mk-create.log" 2>&1; log "mkqnximage create rc=$?"
[ -d local/snippets ] || { log "IMAGE CREATE FAILED"; tail -5 "$W/mk-create.log" | tee -a "$R"; cp "$R" "$OUT/"; exit 1; }
for par in "automata-hello:MCP" "automata-msgpass:MSGPASS" "automata-resmgr:RESMGR" "automata-pulses:PULSES" "automata-events:EVENTS" "automata-prio:PRIO" "automata-name:NAME"; do
  b=${par%%:*}; m=${par##*:}
  cp "$B/$b" "$D/$b"
  echo "[perms=0755] $b=$D/$b" >> local/snippets/ifs_files.custom
  printf 'echo "QNX_%s_RUN_BEGIN"\n/proc/boot/%s\necho "QNX_%s_RUN_EXIT=$?"\n' "$m" "$b" "$m" >> local/snippets/post_start.custom
done
mkqnximage --noprompt --build > "$W/mk-build.log" 2>&1; log "mkqnximage build rc=$?"
[ -f output/ifs.bin ] || { log "IMAGE BUILD FAILED"; tail -5 "$W/mk-build.log" | tee -a "$R"; cp "$R" "$OUT/"; exit 1; }

log "== boot (QEMU, no network, serial console to file)"
rm -f output/qemu.out
qemu-system-x86_64 -smp 2 -cpu max -m 1G \
  -drive file=output/disk-qemu.vmdk,if=ide,id=drv0 \
  -kernel output/ifs.bin -display none -monitor none -nic none \
  -serial file:output/qemu.out -pidfile output/qemu.pid \
  -object rng-random,filename=/dev/urandom,id=rng0 -device virtio-rng-pci,rng=rng0 &
QPID=$!
for i in $(seq 1 120); do
  sleep 4
  if grep -q 'QNX_NAME_RUN_EXIT' output/qemu.out 2>/dev/null; then break; fi
  if ! kill -0 "$QPID" 2>/dev/null; then log "QEMU exited early"; break; fi
done
sleep 3
kill -TERM "$QPID" 2>/dev/null
wait "$QPID" 2>/dev/null
log "qemu processes left: $(pgrep -c qemu-system || true)"

log "== check-run.sh from the cloned revision"
tr -d '\r' < output/qemu.out > "$W/qemu-serial-console.txt"
bash "$W/src/tutorial/check-run.sh" "$W/qemu-serial-console.txt" 2>&1 | tee -a "$R"
log "check-run exit status: ${PIPESTATUS[0]}"
log "console sha256 $(sha256sum "$W/qemu-serial-console.txt" | cut -c1-64) lines $(wc -l < "$W/qemu-serial-console.txt")"
grep -c -i "martin" "$W/qemu-serial-console.txt" "$R" | tee -a "$R"
cp "$R" "$W/qemu-serial-console.txt" "$D/local/snippets/ifs_files.custom" "$D/local/snippets/post_start.custom" "$OUT/"
echo "DONE"

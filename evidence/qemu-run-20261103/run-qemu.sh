#!/bin/bash
cd /root/qnx-run
rm -f output/qemu.out
qemu-system-x86_64 -smp 2 -cpu max -m 1G \
  -drive file=output/disk-qemu.vmdk,if=ide,id=drv0 \
  -kernel output/ifs.bin -display none -monitor none -nic none \
  -serial file:output/qemu.out -pidfile output/qemu.pid \
  -object rng-random,filename=/dev/urandom,id=rng0 -device virtio-rng-pci,rng=rng0 &
QPID=$!
for i in $(seq 1 90); do
  sleep 4
  if grep -q "QNX_MCP_RUN_EXIT" output/qemu.out 2>/dev/null; then echo "listo a los $((i*4)) s"; break; fi
done
sleep 3
kill -TERM $QPID 2>/dev/null; wait $QPID 2>/dev/null; echo "qemu terminado: $?"
pgrep -a qemu-system || echo "sin qemu corriendo"
echo "===== consola"
tr -d '\r' < output/qemu.out | tail -40

// Linux x86_64 /proc/net/tcp{,6}: addresses use little-endian 32-bit words.
// This function performs no I/O and inspects only the supplied owned inodes.
export function unsafeListeningPorts(tcpText, tcp6Text, ownedInodes) {
  if (typeof tcpText !== 'string' || typeof tcp6Text !== 'string' || !Array.isArray(ownedInodes)) {
    throw new TypeError('Expected two proc table strings and an inode array.');
  }
  const owned = new Set(ownedInodes.map(value => {
    const inode = String(value);
    if (!/^[0-9]+$/.test(inode)) throw new TypeError('Invalid socket inode.');
    return inode;
  }));
  const ports = new Set();
  for (const [text, addressLength, loopback] of [
    [tcpText, 8, '0100007F'],
    [tcp6Text, 32, '00000000000000000000000001000000'],
  ]) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || /^sl\s+local_address\s/.test(trimmed)) continue;
      const fields = trimmed.split(/\s+/);
      const local = fields[1]?.match(/^([0-9a-f]+):([0-9a-f]{4})$/i);
      if (fields.length < 10 || !/^\d+:$/.test(fields[0]) ||
          !local || local[1].length !== addressLength ||
          !/^[0-9a-f]{2}$/i.test(fields[3]) || !/^\d+$/.test(fields[9])) {
        throw new TypeError('Malformed proc socket table; network safety is unknown.');
      }
      if (fields[3].toUpperCase() !== '0A' || !owned.has(fields[9])) continue;
      if (local[1].toUpperCase() !== loopback) ports.add(Number.parseInt(local[2], 16));
    }
  }
  return [...ports].sort((left, right) => left - right);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { unsafeListeningPorts } from '../src/net-check.mjs';

const header = '  sl  local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n';
function row(address, port, inode, state = '0A') {
  const remote = '0'.repeat(address.length);
  return `0: ${address}:${port} ${remote}:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode} 1\n`;
}

test('accepts exact IPv4 and IPv6 loopback listeners', () => {
  assert.deepEqual(unsafeListeningPorts(
    header + row('0100007F', '08AE', '101'),
    header + row('00000000000000000000000001000000', '08AF', '102'),
    ['101', '102'],
  ), []);
});

test('reports owned wildcard listeners for both address families', () => {
  assert.deepEqual(unsafeListeningPorts(
    header + row('00000000', '08AE', '101'),
    header + row('00000000000000000000000000000000', '08AF', '102'),
    ['101', '102'],
  ), [2222, 2223]);
});

test('reports non-loopback addresses and excludes unrelated sockets', () => {
  const tcp = header
    + row('0200007F', '08AE', '101')
    + row('0101A8C0', '1F90', '102')
    + row('00000000', '0050', '999')
    + row('00000000', '01BB', '103', '01');
  assert.deepEqual(unsafeListeningPorts(tcp, header, ['101', '102', '103']), [2222, 8080]);
});

test('does not treat IPv4-mapped IPv6 addresses as exact IPv6 loopback', () => {
  assert.deepEqual(unsafeListeningPorts(
    header, header + row('0000000000000000FFFF00000100007F', '08AE', '101'), ['101'],
  ), [2222]);
});

test('deduplicates and sorts ports across owned sockets', () => {
  const tcp = header + row('00000000', '1F90', '101') + row('00000000', '08AE', '102');
  const tcp6 = header + row('00000000000000000000000000000000', '1F90', '103');
  assert.deepEqual(unsafeListeningPorts(tcp, tcp6, ['101', '102', '103']), [2222, 8080]);
});

test('returns no ports for tables containing only headers', () => {
  assert.deepEqual(unsafeListeningPorts(header, header, []), []);
});

test('rejects malformed observations instead of claiming network safety', () => {
  for (const table of ['invalid row', header + row('BAD', '08AE', '101')]) {
    assert.throws(() => unsafeListeningPorts(table, header, ['101']), TypeError);
  }
  assert.throws(() => unsafeListeningPorts(null, header, []), TypeError);
  assert.throws(() => unsafeListeningPorts(header, header, ['invalid']), TypeError);
});

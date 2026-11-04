import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Execute the actual observer against deterministic procfs fixtures.
// Only its filesystem import is replaced; production code stays unchanged.
let sequence = 0;
async function observer({ ownedZombie = false, failedRead = false } = {}) {
  const leader = process.pid + 10000;
  const other = leader + 1;
  const stat = (pid, state, group) =>
    `${pid} (fixture) ${state} 1 ${group} ${group} ${Array(15).fill('0').join(' ')} 123\n`;
  const failure = () => Object.assign(new Error('Synthetic procfs read failure'), { code: 'EIO' });
  const io = {
    async readFile(filename) {
      if (filename === `/proc/${leader}/stat`) return stat(leader, 'S', leader);
      if (filename === `/proc/${other}/stat`) {
        return stat(other, 'Z', ownedZombie ? leader : other);
      }
      if (filename === `/proc/${leader}/net/tcp` ||
          filename === `/proc/${leader}/net/tcp6`) {
        if (failedRead) throw failure();
        return 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n';
      }
      throw new Error(`Unexpected read: ${filename}`);
    },
    async readdir(directory) {
      if (directory === '/proc') return [String(leader), String(other), 'self'];
      if (directory === `/proc/${leader}/fd`) return [];
      throw new Error(`Unexpected directory: ${directory}`);
    },
    async readlink(filename) {
      throw new Error(`Unexpected link: ${filename}`);
    },
  };
  const original = await readFile(new URL('../src/proc-sockets.mjs', import.meta.url), 'utf8');
  const dependency = "import { readFile, readdir, readlink } from 'node:fs/promises';";
  assert.equal(original.split(dependency).length, 2, 'Filesystem import must be unique.');
  const key = `qnx-procfs-regression-${++sequence}`;
  globalThis[key] = io;
  try {
    const source = original.replace(dependency,
      `const { readFile, readdir, readlink } = globalThis[${JSON.stringify(key)}];`);
    const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    const token = await module.captureOwnedGroup(leader);
    return { module, token };
  } finally {
    delete globalThis[key];
  }
}

const options = { skip: process.platform !== 'linux' };

test('an unrelated zombie does not invalidate a complete owned group observation', options, async () => {
  const { module, token } = await observer();
  const snapshot = await module.readOwnedGroupSockets(token);
  assert.equal(typeof snapshot.tcpText, 'string');
  assert.equal(typeof snapshot.tcp6Text, 'string');
  assert.deepEqual(snapshot.ownedInodes, []);
});

test('a zombie belonging to the owned group still invalidates observation', options, async () => {
  const { module, token } = await observer({ ownedZombie: true });
  await assert.rejects(() => module.readOwnedGroupSockets(token),
    /Owned process socket observation could not be established/);
});

test('a failed network table read never becomes an empty valid observation', options, async () => {
  const { module, token } = await observer({ failedRead: true });
  await assert.rejects(() => module.readOwnedGroupSockets(token),
    /Owned process socket observation could not be established/);
});

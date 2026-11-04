import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { captureOwnedGroup, readOwnedGroupSockets } from '../src/proc-sockets.mjs';
import { unsafeListeningPorts } from '../src/net-check.mjs';

const linuxOnly = { skip: process.platform !== 'linux' ? 'Requires Linux procfs.' : false };

async function fixture(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, shell: false, stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  await once(child, 'spawn');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const token = await captureOwnedGroup(child.pid);
  return { child, token, exited };
}

test('captures the identity of a detached server-owned child', linuxOnly, async t => {
  const { child, token } = await fixture(t);
  assert.equal(token.pid, child.pid);
  assert.equal(token.group, child.pid);
  assert.equal(token.session, child.pid);
  assert.match(token.startTime, /^[0-9]+$/);
  assert.equal(Object.isFrozen(token), true);
});

test('reads a live owned group without opening network sockets', linuxOnly, async t => {
  const { token } = await fixture(t);
  const snapshot = await readOwnedGroupSockets(token);
  assert.equal(typeof snapshot.tcpText, 'string');
  assert.equal(typeof snapshot.tcp6Text, 'string');
  assert.deepEqual(snapshot.ownedInodes, []);
  assert.deepEqual(unsafeListeningPorts(
    snapshot.tcpText, snapshot.tcp6Text, snapshot.ownedInodes,
  ), []);
});

test('rejects altered identities and invalid process identifiers', linuxOnly, async t => {
  const { token } = await fixture(t);
  for (const changed of [
    { ...token, startTime: String(BigInt(token.startTime) + 1n) },
    { ...token, group: token.group + 1 },
    { ...token, session: token.session + 1 },
    null,
  ]) {
    await assert.rejects(() => readOwnedGroupSockets(changed));
  }
  for (const pid of [0, 1, -1, process.pid, null, '123']) {
    await assert.rejects(() => captureOwnedGroup(pid));
  }
});

test('rejects an exited launcher instead of returning an empty observation', linuxOnly, async t => {
  const { child, token, exited } = await fixture(t);
  child.kill('SIGKILL');
  await exited;
  await assert.rejects(() => readOwnedGroupSockets(token));
  await assert.rejects(() => captureOwnedGroup(token.pid));
});

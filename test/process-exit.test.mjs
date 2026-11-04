import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { captureOwnedGroup, ownedProcessExists } from '../src/proc-sockets.mjs';

test('confirms disappearance of a captured process identity', {
  skip: process.platform !== 'linux', timeout: 10000,
}, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore',
  });
  const closed = new Promise(resolve => {
    child.once('close', resolve);
    child.once('error', resolve);
  });
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const token = await captureOwnedGroup(child.pid);
    assert.equal(await ownedProcessExists(token), true);
    await assert.rejects(ownedProcessExists({ ...token, startTime: 'invalid' }));
    assert.equal(await ownedProcessExists(token), true);
    child.kill('SIGTERM');
    await closed;
    assert.equal(await ownedProcessExists(token), false);
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await closed;
  }
});

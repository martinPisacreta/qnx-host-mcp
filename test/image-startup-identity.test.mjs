import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Executor } from '../src/executor.mjs';
import { captureOwnedGroup, ownedProcessExists } from '../src/proc-sockets.mjs';

test('startup cleanup rejects altered launcher identity without attempting signals', {
  skip: process.platform !== 'linux',
  timeout: 10000,
}, async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  const instance = { child, target: null, launcher: null, closed: false };
  const closed = new Promise(resolve => {
    child.once('close', () => { instance.closed = true; resolve(); });
  });
  let original;
  let signalSpy;
  const cleanup = () => Executor.prototype.cleanupImageInstance.call({ graceMs: 50 }, instance);

  t.after(async () => {
    signalSpy?.mock.restore();
    if (original) {
      instance.launcher = original;
      await cleanup();
    } else if (!instance.closed) {
      child.kill('SIGKILL');
    }
    await closed;
  });

  await once(child, 'spawn');
  original = await captureOwnedGroup(child.pid);
  instance.launcher = Object.freeze({
    ...original,
    startTime: String(BigInt(original.startTime) + 1n),
  });

  const realKill = process.kill;
  signalSpy = t.mock.method(process, 'kill', function (...args) {
    return Reflect.apply(realKill, process, args);
  });
  try {
    await assert.rejects(cleanup, error => error.code === 'CANCEL_FAILED');
    assert.equal(signalSpy.mock.callCount(), 0, 'identity mismatch must precede every signal attempt');
    assert.equal(await ownedProcessExists(original), true);
  } finally {
    signalSpy.mock.restore();
    instance.launcher = original;
  }

  await cleanup();
  await closed;
  assert.equal(await ownedProcessExists(original), false);
});

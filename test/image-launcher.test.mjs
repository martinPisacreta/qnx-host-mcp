import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Executor } from '../src/executor.mjs';
import { ownedProcessExists } from '../src/proc-sockets.mjs';

async function fixture(t, mode) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qnx-launcher-'));
  await mkdir(path.join(directory, 'output'));
  const executable = path.join(directory, 'mkqnximage');
  const program = `#!${process.execPath}
const { spawn } = require('node:child_process');
const { writeFileSync, renameSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
child.once('spawn', () => {
  if (${JSON.stringify(mode)} !== 'missing') {
    writeFileSync('output/qemu.pid.tmp', String(${JSON.stringify(mode)} === 'foreign' ? process.ppid : child.pid));
    renameSync('output/qemu.pid.tmp', 'output/qemu.pid');
  }
  process.stdout.write('launcher ready' + String.fromCharCode(10));
});
process.on('SIGTERM', () => {
  child.once('exit', () => process.exit(0));
  child.kill('SIGTERM');
});
setInterval(() => {}, 1000);
`;
  await writeFile(executable, program, { mode: 0o700 });
  const executor = new Executor(directory, { PATH: process.env.PATH },
    { qnx_image_start: 1000, qnx_image_stop: 1000 }, 50);
  const operation = {
    result: { state: 'running', stdout: '', stderr: '', truncated: false, exitCode: null },
    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stopReason: null, child: null,
  };
  t.after(async () => {
    const instance = operation.imageInstance;
    let cleanupError;
    if (instance?.child.pid && !instance.closed) {
      const signal = value => {
        try { process.kill(-instance.child.pid, value); }
        catch (error) { if (error.code !== 'ESRCH') cleanupError = error; }
      };
      const timer = setTimeout(() => signal('SIGKILL'), 1000);
      try {
        signal('SIGTERM');
        await instance.done;
      } finally { clearTimeout(timer); }
    }
    await rm(directory, { recursive: true, force: true });
    if (cleanupError) throw cleanupError;
  });
  const instance = await executor.launchImageProcess(operation, executable, directory);
  return { executor, operation, instance };
}

const options = { skip: process.platform !== 'linux', timeout: 10000 };

test('persistent launcher verifies its live descendant and keeps stdin private', options, async t => {
  const { executor, operation, instance } = await fixture(t, 'owned');
  const target = await executor.awaitImageProcess(operation, instance);
  assert.notEqual(target.pid, instance.child.pid);
  assert.equal(instance.exited, false);
  assert.equal(instance.child.stdin.destroyed, false);
  assert.equal(instance.child.stdin.bytesWritten, 0);
  assert.equal(await ownedProcessExists(target), true);
  assert.equal(await ownedProcessExists(instance.launcher), true);
});

test('persistent launcher rejects a pidfile naming an unrelated process', options, async t => {
  const { executor, operation, instance } = await fixture(t, 'foreign');
  await assert.rejects(executor.awaitImageProcess(operation, instance),
    error => error.code === 'UNSAFE_CONFIGURATION');
  assert.equal(instance.target, null);
});

test('persistent launcher bounds the wait for a missing pidfile', options, async t => {
  const { executor, operation, instance } = await fixture(t, 'missing');
  await assert.rejects(executor.awaitImageProcess(operation, instance),
    error => error.code === 'TIMEOUT');
  assert.equal(instance.target, null);
});

test('persistent launcher observes cancellation while waiting for a pidfile', options, async t => {
  const { executor, operation, instance } = await fixture(t, 'missing');
  const timer = setTimeout(() => { operation.stopReason = 'CANCELLED'; }, 50);
  try {
    await assert.rejects(executor.awaitImageProcess(operation, instance),
      error => error.code === 'CANCELLED');
    assert.equal(instance.target, null);
  } finally { clearTimeout(timer); }
});

test('verified image rejects a supplied non-loopback TCP listener', options, async t => {
  const { executor, operation, instance } = await fixture(t, 'owned');
  await executor.awaitImageProcess(operation, instance);
  executor.imageNetworkSnapshot = async ({ target, launcher }) => {
    assert.equal(target.pid, instance.target.pid);
    assert.equal(launcher.pid, instance.launcher.pid);
    return {
      tcpText: 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n' +
        '0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 12345\n',
      tcp6Text: '', ownedInodes: ['12345'],
    };
  };
  await assert.rejects(executor.checkImageProcessNetwork(operation, instance, 'example'),
    error => error.code === 'UNSAFE_NETWORK');
});

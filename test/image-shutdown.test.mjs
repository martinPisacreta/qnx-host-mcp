import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Executor } from '../src/executor.mjs';
import { captureOwnedDescendant, ownedProcessExists } from '../src/proc-sockets.mjs';

const options = { skip: process.platform !== 'linux', timeout: 20000 };
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

async function waitFor(executor, id, predicate = result => terminal.has(result.state)) {
  const expires = Date.now() + 10000;
  while (Date.now() < expires) {
    const result = await executor.call('qnx_operation_status', { operationId: id });
    if (predicate(result)) return result;
    await delay(10);
  }
  assert.fail('Image operation did not reach the expected state.');
}

async function perform(executor, action) {
  const initial = await executor.imageOperation(action, 'demo');
  return waitFor(executor, initial.operationId);
}

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'qnx-image-shutdown-'));
  const root = path.join(base, 'workspace');
  const bin = path.join(base, 'bin');
  await mkdir(root);
  await mkdir(bin);
  await writeFile(path.join(bin, 'mkqnximage'), `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const argv = process.argv.slice(2);
if (argv.length !== 3 || argv[0] !== '--type=qemu' || argv[1] !== '--arch=x86_64') process.exit(90);
if (argv[2] === '--run') {
  fs.mkdirSync('output', { recursive: true });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  child.once('error', () => process.exit(91));
  child.once('exit', () => process.exit(0));
  process.on('SIGTERM', () => { child.kill('SIGTERM'); });
  child.once('spawn', () => {
    fs.writeFileSync('output/test-child.pid', String(child.pid));
    if (!fs.existsSync('wait-start')) fs.writeFileSync('output/qemu.pid', String(child.pid));
    console.log('FAKE LAUNCHER READY');
  });
  setInterval(() => {}, 1000);
} else if (argv[2] === '--stop') {
  const pid = Number(fs.readFileSync('output/qemu.pid', 'utf8').trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) process.exit(92);
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
} else if (argv[2] !== '--build') process.exit(93);
`, { mode: 0o700 });
  const executor = await Executor.create({
    env: { PATH: bin, QNX_MCP_WORKSPACE: root },
    graceMs: 50,
    imageNetworkSnapshot: async () => ({ tcpText: '', tcp6Text: '', ownedInodes: [] }),
  });
  t.after(async () => {
    await executor.close();
    await rm(base, { recursive: true, force: true });
  });
  assert.equal((await perform(executor, 'build')).state, 'succeeded');
  return { root, executor };
}

test('startup cancellation confirms launcher and child removal before releasing the lock', options, async t => {
  const { root, executor } = await fixture(t);
  const directory = path.join(root, 'images', 'demo');
  await writeFile(path.join(directory, 'wait-start'), '');
  const started = await executor.imageOperation('start', 'demo');
  await waitFor(executor, started.operationId, result => result.stdout.includes('FAKE LAUNCHER READY'));
  const instance = executor.operations.get(started.operationId).imageInstance;
  const launcher = instance.launcher;
  const pid = Number(await readFile(path.join(directory, 'output', 'test-child.pid'), 'utf8'));
  const target = await captureOwnedDescendant(launcher, pid);
  assert.equal(await ownedProcessExists(target), true);
  await assert.rejects(() => executor.imageOperation('build', 'other'), error => error.code === 'BUSY');
  const requested = await executor.call('qnx_operation_cancel', { operationId: started.operationId });
  assert.equal(requested.cancellationAccepted, true);
  assert.equal(requested.state, 'running');
  const result = await waitFor(executor, started.operationId);
  assert.equal(result.state, 'cancelled', result.message);
  assert.equal(result.errorCode, 'CANCELLED');
  assert.equal(await ownedProcessExists(target), false);
  assert.equal(await ownedProcessExists(launcher), false);
  assert.equal(executor.images.get('demo').running, false);
  assert.equal(executor.images.get('demo').instance, null);
  assert.equal((await perform(executor, 'build')).state, 'succeeded');
});

test('executor close removes a successfully started image and its persistent launcher', options, async t => {
  const { executor } = await fixture(t);
  const started = await perform(executor, 'start');
  assert.equal(started.state, 'succeeded', started.message);
  const instance = executor.images.get('demo').instance;
  const { target, launcher } = instance;
  assert.equal(await ownedProcessExists(target), true);
  assert.equal(await ownedProcessExists(launcher), true);
  await executor.close();
  assert.equal(await ownedProcessExists(target), false);
  assert.equal(await ownedProcessExists(launcher), false);
  assert.equal(executor.images.get('demo').running, false);
  assert.equal(executor.images.get('demo').instance, null);
});


test('stop rejects an altered launcher identity while preserving the controlled processes', options, async t => {
  const { executor } = await fixture(t);
  const started = await perform(executor, 'start');
  assert.equal(started.state, 'succeeded', started.message);
  const instance = executor.images.get('demo').instance;
  const launcher = instance.launcher;
  const target = instance.target;
  try {
    instance.launcher = Object.freeze({
      ...launcher,
      startTime: String(BigInt(launcher.startTime) + 1n),
    });
    await assert.rejects(
      () => executor.stopOwnedImage(instance),
      error => error.code === 'CANCEL_FAILED',
    );
    assert.equal(await ownedProcessExists(launcher), true);
    assert.equal(await ownedProcessExists(target), true);
  } finally {
    instance.launcher = launcher;
  }
  const stopped = await perform(executor, 'stop');
  assert.equal(stopped.state, 'succeeded', stopped.message);
  assert.equal(await ownedProcessExists(target), false);
  assert.equal(await ownedProcessExists(launcher), false);
});

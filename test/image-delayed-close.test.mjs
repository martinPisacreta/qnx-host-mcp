import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Executor } from '../src/executor.mjs';
import { ownedProcessExists } from '../src/proc-sockets.mjs';

async function waitUntil(predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail('Expected condition was not observed.');
}

async function perform(executor, action) {
  const initial = await executor.imageOperation(action, 'demo');
  let result;
  await waitUntil(async () => {
    result = await executor.call('qnx_operation_status', { operationId: initial.operationId });
    return ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(result.state);
  });
  assert.equal(result.state, 'succeeded', result.message);
  return result;
}

test('cleanup waits for delayed close confirmation after target and launcher disappear', {
  skip: process.platform !== 'linux', timeout: 20000,
}, async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'qnx-delayed-close-'));
  const workspace = path.join(base, 'workspace');
  const bin = path.join(base, 'bin');
  await mkdir(workspace);
  await mkdir(bin);
  t.after(() => rm(base, { recursive: true, force: true }));
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
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.once('spawn', () => fs.writeFileSync('output/qemu.pid', String(child.pid)));
  setInterval(() => {}, 1000);
} else if (argv[2] === '--stop') {
  const pid = Number(fs.readFileSync('output/qemu.pid', 'utf8').trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) process.exit(92);
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
} else if (argv[2] !== '--build') process.exit(93);
`, { mode: 0o700 });
  const executor = await Executor.create({
    env: { PATH: bin, QNX_MCP_WORKSPACE: workspace },
    graceMs: 50,
    imageNetworkSnapshot: async () => ({ tcpText: '', tcp6Text: '', ownedInodes: [] }),
  });
  t.after(() => executor.close());
  await perform(executor, 'build');
  await perform(executor, 'start');
  const instance = executor.images.get('demo').instance;
  const descriptor = Object.getOwnPropertyDescriptor(instance, 'closed');
  assert.ok(descriptor && 'value' in descriptor && descriptor.configurable);
  let actualClosed = instance.closed;
  let releaseClose = false;
  Object.defineProperty(instance, 'closed', {
    configurable: true,
    get: () => actualClosed && releaseClose,
    set: value => { actualClosed = value; },
  });
  const originalCommand = executor.command;
  let stopReturnedAfterRemoval = false;
  let settled = false;
  let pending;
  executor.command = async function(operation, executable, argv, cwd) {
    const result = await originalCommand.call(this, operation, executable, argv, cwd);
    if (argv.includes('--stop')) {
      await waitUntil(async () => actualClosed &&
        !(await ownedProcessExists(instance.target)) &&
        !(await ownedProcessExists(instance.launcher)));
      stopReturnedAfterRemoval = true;
    }
    return result;
  };
  try {
    pending = executor.stopOwnedImage(instance).then(
      value => { settled = true; return { value }; },
      error => { settled = true; return { error }; },
    );
    await waitUntil(() => stopReturnedAfterRemoval || settled);
    assert.equal(stopReturnedAfterRemoval, true);
    assert.equal(actualClosed, true);
    assert.equal(instance.closed, false);
    await delay(100);
    assert.equal(settled, false, 'Cleanup must remain pending until close is confirmed.');
    releaseClose = true;
    const outcome = await pending;
    assert.ifError(outcome.error);
    assert.equal(outcome.value.forced, false);
    assert.equal(await ownedProcessExists(instance.target), false);
    assert.equal(await ownedProcessExists(instance.launcher), false);
  } finally {
    releaseClose = true;
    if (pending) await pending;
    executor.command = originalCommand;
    Object.defineProperty(instance, 'closed', { ...descriptor, value: actualClosed });
  }
});

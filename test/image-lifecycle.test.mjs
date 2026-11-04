import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Executor } from '../src/executor.mjs';

// Internal interface only: imageOperation(action, imageName).
// No image operation is exposed through the MCP dispatcher.
const linuxOnly = { skip: process.platform !== 'linux' ? 'Linux fake-executable tests.' : false };
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const header = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n';
const unsafeTable = header + '0: 00000000:08AE 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 101 1\n';
const safeSnapshot = async () => ({ tcpText: header, tcp6Text: header, ownedInodes: [] });
const hasCode = code => error => error.code === code;

async function fixture(t, options = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'qnx-image-test-'));
  const root = path.join(base, 'workspace');
  const bin = path.join(base, 'bin');
  const log = path.join(base, 'calls.jsonl');
  await mkdir(root);
  await mkdir(bin);
  const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const action = argv[2];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd() }) + String.fromCharCode(10));
if (argv.length !== 3 || argv[0] !== '--type=qemu' || argv[1] !== '--arch=x86_64' || !['--build', '--run', '--getip', '--stop'].includes(action)) process.exit(90);
if (action === '--build' && fs.existsSync(path.join(process.cwd(), 'wait-build'))) {
  process.on('SIGTERM', () => {});
  console.log('FAKE WAITING');
  setInterval(() => {}, 1000);
} else if (argv[2] === '--run') {
  const { spawn } = require('node:child_process');
  fs.mkdirSync('output', { recursive: true });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  child.once('error', () => process.exit(92));
  child.once('spawn', () => {
    fs.writeFileSync('output/qemu.pid', String(child.pid));
    console.log('FAKE RUNNING');
  });
  child.once('exit', () => process.exit(0));
  process.on('SIGTERM', () => { child.kill('SIGTERM'); });
  setInterval(() => {}, 1000);
} else if (argv[2] === '--stop') {
  if (fs.existsSync('fail-stop')) process.exit(7);
  const pid = Number(fs.readFileSync('output/qemu.pid', 'utf8').trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) process.exit(93);
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
} else if (action === '--getip') console.log('192.0.2.10');
else console.log('FAKE ' + action);
`;
  await writeFile(path.join(bin, 'mkqnximage'), script, { mode: 0o700 });
  const executor = await Executor.create({
    env: { PATH: bin, QNX_MCP_WORKSPACE: root },
    imageNetworkSnapshot: safeSnapshot,
    graceMs: 30,
    ...options,
  });
  t.after(async () => {
    try { await executor.close(); }
    finally { await rm(base, { recursive: true, force: true }); }
  });
  return { base, root, executor, async calls() {
    try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  } };
}

async function waitFor(executor, id, predicate = result => terminal.has(result.state)) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await executor.call('qnx_operation_status', { operationId: id });
    if (predicate(result)) return result;
    await delay(10);
  }
  assert.fail('Image operation did not reach the expected state.');
}

async function perform(executor, action, name = 'demo') {
  const operation = await executor.imageOperation(action, name);
  return waitFor(executor, operation.operationId);
}

test('direct image lifecycle uses fixed argv and one workspace image directory', linuxOnly, async t => {
  const { root, executor, calls } = await fixture(t);
  for (const action of ['build', 'start', 'ip', 'stop']) {
    const result = await perform(executor, action);
    assert.equal(result.state, 'succeeded', result.message);
    assert.equal(result.errorCode, null);
    if (action === 'ip') assert.match(result.stdout, /192[.]0[.]2[.]10/);
  }
  assert.deepEqual(await calls(), ['--build', '--run', '--getip', '--stop'].map(flag => ({
    argv: ['--type=qemu', '--arch=x86_64', flag], cwd: path.join(root, 'images', 'demo'),
  })));
});

test('rejects image names and actions outside the direct interface contract', linuxOnly, async t => {
  const { executor, calls } = await fixture(t);
  for (const name of ['', '../escape', '/tmp/image', 'Uppercase', 'with space', 'a/b', 'a'.repeat(33), null]) {
    await assert.rejects(() => executor.imageOperation('build', name), hasCode('INVALID_INPUT'));
  }
  await assert.rejects(() => executor.imageOperation('--wipe', 'demo'), hasCode('INVALID_INPUT'));
  assert.deepEqual(await calls(), []);
});

test('rejects an image directory that resolves outside the workspace', linuxOnly, async t => {
  const { base, root, executor, calls } = await fixture(t);
  const outside = path.join(base, 'outside');
  await mkdir(outside);
  await mkdir(path.join(root, 'images'));
  await symlink(outside, path.join(root, 'images', 'demo'));
  const result = await perform(executor, 'build');
  assert.equal(result.state, 'failed');
  assert.equal(result.errorCode, 'OUTSIDE_WORKSPACE');
  assert.deepEqual(await calls(), []);
});

test('permits only one direct image operation at a time and confirms cancellation', linuxOnly, async t => {
  const { root, executor } = await fixture(t);
  await mkdir(path.join(root, 'images', 'demo'), { recursive: true });
  await writeFile(path.join(root, 'images', 'demo', 'wait-build'), '');
  const operation = await executor.imageOperation('build', 'demo');
  await waitFor(executor, operation.operationId, result => result.stdout.includes('FAKE WAITING'));
  await assert.rejects(() => executor.imageOperation('build', 'other'), hasCode('BUSY'));
  await assert.rejects(() => executor.call('qnx_toolchain_info', {}), hasCode('BUSY'));
  await assert.rejects(() => executor.imageOperation('start', 'demo'), hasCode('BUSY'));
  const requested = await executor.call('qnx_operation_cancel', { operationId: operation.operationId });
  assert.equal(requested.cancellationAccepted, true);
  const result = await waitFor(executor, operation.operationId);
  assert.equal(result.state, 'cancelled');
  assert.equal(result.errorCode, 'CANCELLED');
  await rm(path.join(root, 'images', 'demo', 'wait-build'));
  assert.equal((await perform(executor, 'build')).state, 'succeeded');
});

test('enforces the image build deadline and releases the operation lock', linuxOnly, async t => {
  const { root, executor } = await fixture(t, { deadlines: { qnx_image_build: 300 } });
  await mkdir(path.join(root, 'images', 'demo'), { recursive: true });
  await writeFile(path.join(root, 'images', 'demo', 'wait-build'), '');
  const result = await perform(executor, 'build');
  assert.equal(result.state, 'timed_out');
  assert.equal(result.errorCode, 'TIMEOUT');
  await rm(path.join(root, 'images', 'demo', 'wait-build'));
  assert.equal((await perform(executor, 'build')).state, 'succeeded');
});

test('unsafe owned listener causes start to stop its image before returning failure', linuxOnly, async t => {
  const { root, executor, calls } = await fixture(t, {
    imageNetworkSnapshot: async () => ({ tcpText: unsafeTable, tcp6Text: header, ownedInodes: ['101'] }),
  });
  assert.equal((await perform(executor, 'build')).state, 'succeeded');
  const result = await perform(executor, 'start');
  assert.equal(result.state, 'failed');
  assert.equal(result.errorCode, 'UNSAFE_NETWORK');
  const recorded = await calls();
  assert.deepEqual(recorded.map(call => call.argv[2]), ['--build', '--run', '--stop']);
  assert.ok(recorded.every(call => call.cwd === path.join(root, 'images', 'demo')));
});

test('direct image implementation does not enable any MCP image tool', linuxOnly, async t => {
  const { executor, calls } = await fixture(t);
  for (const suffix of ['build', 'start', 'ip', 'stop']) {
    await assert.rejects(() => executor.call('qnx_image_' + suffix, {}), hasCode('UNSAFE_CONFIGURATION'));
  }
  assert.deepEqual(await calls(), []);
});

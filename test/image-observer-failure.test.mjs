import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Executor } from '../src/executor.mjs';
import { ownedProcessExists } from '../src/proc-sockets.mjs';

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

async function perform(executor, action) {
  const initial = await executor.imageOperation(action, 'demo');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await executor.call('qnx_operation_status', { operationId: initial.operationId });
    if (terminal.has(result.state)) return result;
    await delay(10);
  }
  assert.fail('Image operation did not finish within the test deadline.');
}

for (const scenario of [
  { name: 'uses live socket observation when no override is supplied', observerFails: false, stopFails: false },
  { name: 'rejects observer failure after confirmed cleanup', observerFails: true, stopFails: false },
  { name: 'preserves network failure after successful group cleanup when stop fails', observerFails: true, stopFails: true },
]) {
  test(scenario.name, {
    skip: process.platform !== 'linux' ? 'Requires Linux fake executables.' : false,
    timeout: 25000,
  }, async t => {
    const base = await mkdtemp(path.join(tmpdir(), 'qnx-observer-failure-'));
    let executor;
    let observed;
    t.after(async () => {
      try { if (executor) await executor.close(); }
      finally { await rm(base, { recursive: true, force: true }); }
    });
    const root = path.join(base, 'workspace');
    const bin = path.join(base, 'bin');
    const log = path.join(base, 'calls.jsonl');
    await mkdir(root);
    await mkdir(bin);
    await writeFile(path.join(bin, 'mkqnximage'), `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + String.fromCharCode(10));
if (argv.length !== 3 || argv[0] !== '--type=qemu' || argv[1] !== '--arch=x86_64') process.exit(90);
if (!['--build', '--run', '--stop'].includes(argv[2])) process.exit(91);
if (argv[2] === '--run') {
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
}
`, { mode: 0o700 });
    executor = await Executor.create({
      env: { PATH: bin, QNX_MCP_WORKSPACE: root },
      graceMs: 30,
      imageNetworkSnapshot: scenario.observerFails ? async identities => {
        observed = identities;
        throw new Error('Observation unavailable');
      } : undefined,
    });
    assert.equal((await perform(executor, 'build')).state, 'succeeded');
    if (scenario.stopFails) {
      await writeFile(path.join(root, 'images', 'demo', 'fail-stop'), '');
    }
    const result = await perform(executor, 'start');
    if (scenario.observerFails) {
      assert.equal(result.state, 'failed', result.message);
      assert.equal(result.errorCode, 'UNSAFE_NETWORK');
      assert.ok(observed?.launcher);
      assert.ok(observed?.target);
    } else {
      assert.equal(result.state, 'succeeded', result.message);
      assert.equal(result.errorCode, null);
      const instance = executor.images.get('demo').instance;
      observed = { launcher: instance.launcher, target: instance.target };
      assert.equal(await ownedProcessExists(observed.target), true);
      const stopped = await perform(executor, 'stop');
      assert.equal(stopped.state, 'succeeded', stopped.message);
      assert.equal(stopped.stopCommandFailed, false);
    }
    assert.equal(await ownedProcessExists(observed.target), false);
    assert.equal(await ownedProcessExists(observed.launcher), false);
    assert.equal(executor.images.get('demo').running, false);
    assert.equal(executor.images.get('demo').instance, null);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls, ['--build', '--run', '--stop'].map(flag => [
      '--type=qemu', '--arch=x86_64', flag,
    ]));
    for (const action of ['build', 'start', 'ip', 'stop']) {
      await assert.rejects(
        () => executor.call('qnx_image_' + action, {}),
        error => error.code === 'UNSAFE_CONFIGURATION',
      );
    }
  });
}

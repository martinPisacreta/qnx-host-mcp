import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile, mkdir, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Executor } from '../src/executor.mjs';

const nonce = 'a'.repeat(32);
const prefix = `QNX_RUN_${nonce}_`;
const operation = () => ({
  runNonce: nonce,
  result: { console: '', consoleTruncated: false, consoleBytesObserved: 0 },
});
const consume = (op, text, final = false) =>
  Executor.prototype.consumeRunConsole.call({}, op,
    Buffer.isBuffer(text) ? text : Buffer.from(text), final);
const commandFailure = error => error?.code === 'COMMAND_FAILED';

test('console parser accepts fragmented markers and guest exit codes', () => {
  for (const code of [0, 1, 42, 255]) {
    const op = operation();
    const text = `boot\r\n${prefix}BEGIN\r\nguest output\n${prefix}EXIT=${code}\r\n`;
    let result;
    for (const byte of Buffer.from(text)) {
      result = consume(op, Buffer.from([byte]));
    }
    assert.deepEqual(result, { completed: true, exitCode: code });
    assert.equal(op.result.console, text);
    assert.equal(op.result.consoleBytesObserved, Buffer.byteLength(text));
    assert.equal(op.result.consoleTruncated, false);
  }
});

test('console parser continues finding EXIT after retained output reaches 32 KiB', () => {
  const op = operation();
  consume(op, `${prefix}BEGIN\n`);
  const noise = `${'x'.repeat(1023)}\n`;
  for (let index = 0; index < 40; index++) consume(op, noise);
  const result = consume(op, `${prefix}EXIT=17\n`);
  assert.deepEqual(result, { completed: true, exitCode: 17 });
  assert.equal(Buffer.byteLength(op.result.console), 32768);
  assert.equal(op.result.consoleTruncated, true);
  assert.ok(op.result.consoleBytesObserved > 32768);
});

test('console retention does not emit a partial UTF-8 character', () => {
  const op = operation();
  const line = `${'a'.repeat(1023)}\n`;
  for (let index = 0; index < 31; index++) consume(op, line);
  consume(op, `${'b'.repeat(1023)}é\n`);
  assert.equal(op.result.consoleTruncated, true);
  assert.equal(op.result.console.includes('�'), false);
  assert.ok(Buffer.byteLength(op.result.console) <= 32768);
});

test('console parser rejects misplaced, duplicate and malformed markers', () => {
  for (const text of [
    `${prefix}EXIT=0\n`,
    `${prefix}BEGIN\n${prefix}BEGIN\n`,
    `${prefix}BEGIN\n${prefix}EXIT=0\n${prefix}EXIT=1\n`,
    `${prefix}BEGIN\n${prefix}EXIT=0\n${prefix}BEGIN\n`,
    ...['256', '-1', '01', '1.5', '0 trailing', ''].map(code =>
      `${prefix}BEGIN\n${prefix}EXIT=${code}\n`),
  ]) {
    assert.throws(() => consume(operation(), text), commandFailure);
  }
});

test('console parser ignores unrelated nonces and requires complete marker lines', () => {
  const op = operation();
  assert.deepEqual(consume(op, `QNX_RUN_${'b'.repeat(32)}_BEGIN\n`),
    { completed: false, exitCode: null });
  assert.deepEqual(consume(op, `${prefix}BEGIN\n${prefix}EXIT=0`),
    { completed: false, exitCode: null });
  assert.throws(() => consume(op, '', true), commandFailure);
});

test('console parser bounds individual lines and total observed bytes', () => {
  assert.throws(() => consume(operation(), 'x'.repeat(4097)), commandFailure);
  const op = operation();
  const chunk = Buffer.from(`${'x'.repeat(1023)}\n`);
  for (let index = 0; index < 8192; index++) consume(op, chunk);
  assert.equal(op.result.consoleBytesObserved, 8 * 1024 * 1024);
  assert.throws(() => consume(op, 'x'), commandFailure);
  assert.ok(Buffer.byteLength(op.result.console) <= 32768);
});

test('disabled run rejects without creating an operation or workspace files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'qnx-run-disabled-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const configured of [false, true]) {
    const env = { QNX_MCP_WORKSPACE: root, PATH: '' };
    if (configured) {
      const filename = path.join(root, 'run.json');
      await writeFile(filename, JSON.stringify({
        version: 1, enabled: false, templateDir: path.join(root, 'absent-template'),
      }));
      env.QNX_MCP_RUN_CONFIG = filename;
    }
    const executor = await Executor.create({ env });
    try {
      const before = (await readdir(root)).sort();
      await assert.rejects(executor.call('qnx_run_artifact', {
        compileOperationId: 'f'.repeat(32),
      }), error => error?.code === 'UNSAFE_CONFIGURATION');
      assert.equal(executor.operations.size, 0);
      assert.equal(executor.mutatingOperation, null);
      assert.equal(executor.compiler, null);
      assert.deepEqual((await readdir(root)).sort(), before);
    } finally {
      await executor.close();
    }
  }
});

const linuxOnly = { skip: process.platform !== 'linux' };
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

async function poll(action, predicate, milliseconds = 10000) {
  const expires = performance.now() + milliseconds;
  while (true) {
    const value = await action();
    if (predicate(value)) return value;
    if (performance.now() >= expires) assert.fail('Timed out waiting for the fake execution lifecycle.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function enabledFixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'qnx-run-enabled-'));
  const workspace = path.join(root, 'workspace');
  const template = path.join(root, 'template');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'commands.ndjson');
  let executor;
  t.after(async () => {
    try { await executor?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await mkdir(workspace);
  await mkdir(path.join(workspace, 'src'));
  await mkdir(bin);
  await mkdir(path.join(template, 'local', 'snippets'), { recursive: true });
  await mkdir(path.join(template, 'output'));
  await writeFile(path.join(template, 'output', 'operator-output'), 'preserve');
  await writeFile(path.join(template, 'local', 'snippets', 'post_start.custom'), 'operator original');
  await writeFile(path.join(workspace, 'src', 'hello.c'), 'int main(void) { return 0; }\n');
  const common = String.raw`import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: path.basename(process.argv[1]), argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }) + '\n');
`;
  const scripts = {
    qcc: `const args = process.argv.slice(2);
const index = args.indexOf('-o');
if (index >= 0) writeFileSync(args[index + 1], 'synthetic compiled artifact');
`,
    mkqnximage: `setTimeout(() => {
  if (existsSync('output/operator-output')) process.exit(91);
  if (${JSON.stringify(options.buildFailure ?? false)}) process.exit(7);
  mkdirSync('output');
  writeFileSync('output/disk-qemu.vmdk', 'synthetic disk');
  writeFileSync('output/ifs.bin', 'synthetic image');
}, 100);
`,
    'qemu-system-x86_64': String.raw`const snippet = readFileSync('local/snippets/post_start.custom', 'utf8');
const nonce = snippet.match(/QNX_RUN_([a-f0-9]{32})_BEGIN/)?.[1];
if (!nonce) process.exit(92);
if (readFileSync('automata-artifact', 'utf8') !== 'synthetic compiled artifact') process.exit(93);
writeFileSync('output/qemu.out', 'boot\nQNX_RUN_' + nonce + '_BEGIN\n');
setTimeout(() => {
  if (${JSON.stringify(options.missingMarker ?? false)}) process.exit(0);
  if (${JSON.stringify(options.hang ?? false)}) return;
  const noise = ${JSON.stringify(options.largeConsole ?? false)} ? ('x'.repeat(1023) + '\n').repeat(40) : 'guest output\n';
  appendFileSync('output/qemu.out', noise + 'QNX_RUN_' + nonce + '_EXIT=' + ${JSON.stringify(options.guestExitCode ?? 0)} + '\n');
}, 100);
setInterval(() => {}, 1000);
`,
  };
  for (const [name, source] of Object.entries(scripts)) {
    const filename = path.join(bin, name);
    await writeFile(filename, `#!${process.execPath}\n${common}${source}`);
    await chmod(filename, 0o700);
  }
  const config = path.join(root, 'run.json');
  await writeFile(config, JSON.stringify({ version: 1, enabled: true, templateDir: template }));
  executor = await Executor.create({
    env: { QNX_MCP_WORKSPACE: workspace, QNX_MCP_RUN_CONFIG: config, PATH: bin },
    graceMs: 50,
    deadlines: options.deadlines ?? {},
  });
  const status = operationId => executor.call('qnx_operation_status', { operationId });
  const finished = operationId => poll(() => status(operationId), result => terminal.has(result.state));
  const compile = async () => {
    const started = await executor.call('qnx_compile_c', { source: 'src/hello.c' });
    const result = await finished(started.operationId);
    assert.equal(result.state, 'succeeded', JSON.stringify(result));
    return result;
  };
  const commands = async () => {
    try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const assertClean = async () => {
    assert.equal(executor.mutatingOperation, null);
    assert.deepEqual(await readdir(path.join(workspace, 'runs')), []);
    assert.equal(await readFile(path.join(template, 'output', 'operator-output'), 'utf8'), 'preserve');
    assert.equal(await readFile(path.join(template, 'local', 'snippets', 'post_start.custom'), 'utf8'), 'operator original');
    for (const item of await commands()) {
      assert.throws(() => process.kill(item.pid, 0), error => error.code === 'ESRCH');
    }
  };
  return { executor, workspace, template, status, finished, compile, commands, assertClean };
}

test('enabled run builds a private image, reports guest success and cleans up', linuxOnly, async t => {
  const fixture = await enabledFixture(t);
  const compilation = await fixture.compile();
  const started = await fixture.executor.call('qnx_run_artifact', { compileOperationId: compilation.operationId });
  const result = await fixture.finished(started.operationId);
  assert.equal(result.state, 'succeeded', JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.equal(result.buildExitCode, 0);
  assert.equal(result.errorCode, null);
  assert.match(result.console, /guest output/);
  for (const value of Object.values(result.timings)) assert.ok(Number.isFinite(value) && value >= 0);
  const calls = await fixture.commands();
  const build = calls.find(item => item.tool === 'mkqnximage');
  const guest = calls.find(item => item.tool === 'qemu-system-x86_64');
  assert.deepEqual(build.argv, ['--noprompt', '--build']);
  assert.equal(build.cwd, path.join(fixture.workspace, 'runs', started.operationId));
  assert.equal(guest.cwd, build.cwd);
  for (const [flag, value] of [['-nic', 'none'], ['-monitor', 'none'], ['-display', 'none']]) {
    assert.equal(guest.argv[guest.argv.indexOf(flag) + 1], value);
  }
  assert.equal(guest.argv.includes('-daemonize'), false);
  await fixture.assertClean();
});

test('guest nonzero exit remains distinct from the successful build', linuxOnly, async t => {
  const fixture = await enabledFixture(t, { guestExitCode: 42, largeConsole: true });
  const compilation = await fixture.compile();
  const started = await fixture.executor.call('qnx_run_artifact', { compileOperationId: compilation.operationId });
  const result = await fixture.finished(started.operationId);
  assert.equal(result.state, 'failed', JSON.stringify(result));
  assert.equal(result.exitCode, 42);
  assert.equal(result.buildExitCode, 0);
  assert.equal(result.consoleTruncated, true);
  assert.ok(Buffer.byteLength(result.console) <= 32768);
  await fixture.assertClean();
});

test('build failure never launches QEMU and still removes the private directory', linuxOnly, async t => {
  const fixture = await enabledFixture(t, { buildFailure: true });
  const compilation = await fixture.compile();
  const started = await fixture.executor.call('qnx_run_artifact', { compileOperationId: compilation.operationId });
  const result = await fixture.finished(started.operationId);
  assert.equal(result.state, 'failed', JSON.stringify(result));
  assert.equal(result.errorCode, 'COMMAND_FAILED');
  assert.equal(result.buildExitCode, 7);
  assert.equal(result.exitCode, null);
  assert.equal((await fixture.commands()).some(item => item.tool === 'qemu-system-x86_64'), false);
  await fixture.assertClean();
});

test('QEMU exiting without a completion marker cannot report guest success', linuxOnly, async t => {
  const fixture = await enabledFixture(t, { missingMarker: true });
  const compilation = await fixture.compile();
  const started = await fixture.executor.call('qnx_run_artifact', { compileOperationId: compilation.operationId });
  const result = await fixture.finished(started.operationId);
  assert.equal(result.state, 'failed', JSON.stringify(result));
  assert.equal(result.errorCode, 'COMMAND_FAILED');
  assert.equal(result.qemuExitCode, 0);
  assert.equal(result.exitCode, null);
  await fixture.assertClean();
});

test('active run rejects competing work and cancellation cleans up before completion', linuxOnly, async t => {
  const fixture = await enabledFixture(t, { hang: true });
  const compilation = await fixture.compile();
  const started = await fixture.executor.call('qnx_run_artifact', { compileOperationId: compilation.operationId });
  await poll(fixture.commands, calls => calls.some(item => item.tool === 'qemu-system-x86_64'));
  await assert.rejects(fixture.executor.call('qnx_compile_c', { source: 'src/hello.c' }), error => error.code === 'BUSY');
  const cancelled = await fixture.executor.call('qnx_operation_cancel', { operationId: started.operationId });
  assert.equal(cancelled.cancellationAccepted, true);
  const result = await fixture.finished(started.operationId);
  assert.equal(result.state, 'cancelled', JSON.stringify(result));
  assert.equal(result.errorCode, 'CANCELLED');
  await fixture.assertClean();
  await fixture.compile();
});

test('run deadline returns timed_out with TIMEOUT after process and directory cleanup', linuxOnly, async t => {
  const fixture = await enabledFixture(t, { hang: true, deadlines: { qnx_run_artifact: 32000 } });
  const compilation = await fixture.compile();
  const started = await fixture.executor.call('qnx_run_artifact', { compileOperationId: compilation.operationId });
  const result = await fixture.finished(started.operationId);
  assert.equal(result.state, 'timed_out', JSON.stringify(result));
  assert.equal(result.errorCode, 'TIMEOUT');
  assert.equal(result.exitCode, null);
  await fixture.assertClean();
});

test('modified compilation artifact is rejected before invoking an image builder', linuxOnly, async t => {
  const fixture = await enabledFixture(t);
  const compilation = await fixture.compile();
  const artifact = path.join(fixture.workspace, compilation.artifact.path);
  await writeFile(artifact, 'modified artifact');
  const started = await fixture.executor.call('qnx_run_artifact', { compileOperationId: compilation.operationId });
  const result = await fixture.finished(started.operationId);
  assert.equal(result.state, 'failed', JSON.stringify(result));
  assert.equal(result.errorCode, 'UNSAFE_CONFIGURATION');
  assert.equal((await fixture.commands()).some(item => item.tool === 'mkqnximage'), false);
  await fixture.assertClean();
});

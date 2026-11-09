import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Executor } from '../src/executor.mjs';
import { TOOLS, DEADLINES_MS, validateArguments } from '../src/contracts.mjs';

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const linuxOnly = { skip: process.platform === 'win32' ? 'Fake executable scripts require Linux/WSL; native Windows execution is gated.' : false };

async function fixture(t, options = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'qnx-mcp-test-'));
  const root = path.join(base, 'workspace');
  const bin = path.join(base, 'bin');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(bin);
  const fakeCompiler = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') { console.log('FAKE qcc version'); return; }
if (args.length === 1 && args[0] === '-V') { console.log('FAKE gcc_ntox86_64'); return; }
if (args.length !== 4 || args[0] !== '-Vgcc_ntox86_64' || args[1] !== '-o') process.exit(90);
const source = fs.readFileSync(args[3], 'utf8');
if (source.includes('FAIL')) { console.error('FAKE compilation error'); process.exitCode = 2; }
else if (source.includes('WAIT')) {
  process.on('SIGTERM', () => {});
  console.log('FAKE READY');
  setInterval(() => {}, 1000);
} else {
  fs.writeFileSync(args[2], JSON.stringify(args));
  if (source.includes('NOISE')) {
    process.stdout.write('x'.repeat(40000));
    process.stderr.write('y'.repeat(40000));
  } else console.log('FAKE compilation succeeded');
}
`;
  await writeFile(path.join(bin, 'qcc'), fakeCompiler, { mode: 0o700 });
  const marker = path.join(base, 'image-command-ran');
  await writeFile(path.join(bin, 'mkqnximage'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected');\n`.replaceAll('\n', '\n'), { mode: 0o700 });
  await writeFile(path.join(root, 'src', 'hello.c'), 'int main(void) { return 0; }');
  const env = { PATH: bin, QNX_MCP_WORKSPACE: root };
  const executor = await Executor.create({ env, ...options });
  t.after(async () => {
    await executor.close();
    await rm(base, { recursive: true, force: true });
  });
  return { base, root, bin, marker, executor };
}

async function waitFor(executor, id, predicate = result => terminal.has(result.state)) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await executor.call('qnx_operation_status', { operationId: id });
    if (predicate(result)) return result;
    await delay(10);
  }
  assert.fail('Operation did not reach the expected state within five seconds.');
}

function rejectsCode(action, code) {
  return assert.rejects(action, error => error.code === code);
}

test('advertises nine strict tools and the specified deadlines', () => {
  assert.equal(TOOLS.length, 9);
  assert.equal(new Set(TOOLS.map(tool => tool.name)).size, 9);
  for (const tool of TOOLS) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.values(DEADLINES_MS), [30000, 120000, 240000, 900000, 60000, 20000, 30000]);
});

test('every tool rejects client flags and executable overrides', () => {
  for (const tool of TOOLS) {
    const valid = tool.name === 'qnx_compile_c' ? { source: 'src/hello.c' }
      : tool.name.startsWith('qnx_operation_') ? { operationId: 'a'.repeat(32) } : {};
    for (const extra of [{ flags: ['-shared'] }, { argv: ['--wipe'] }, { executable: '/bin/sh' }, { cwd: '/tmp' }]) {
      assert.throws(() => validateArguments(tool.name, { ...valid, ...extra }), error => error.code === 'INVALID_INPUT');
    }
  }
});

test('rejects source paths and strings outside the source contract', () => {
  for (const source of ['../outside.c', '/tmp/file.c', 'src/../file.c', 'src/a.c -shared', 'src/a.c;id', 'src/a.cpp', 'src/sub/a.c']) {
    assert.throws(() => validateArguments('qnx_compile_c', { source }), error => error.code === 'INVALID_INPUT');
  }
});

test('requires an absolute existing workspace', async () => {
  await rejectsCode(() => Executor.create({ env: {} }), 'UNSAFE_CONFIGURATION');
  await rejectsCode(() => Executor.create({ env: { QNX_MCP_WORKSPACE: 'relative' } }), 'UNSAFE_CONFIGURATION');
});

test('compiles with fixed argv and verifies the generated artifact', linuxOnly, async t => {
  const { root, executor } = await fixture(t);
  const started = await executor.call('qnx_compile_c', { source: 'src/hello.c' });
  assert.match(started.operationId, /^[a-f0-9]{32}$/);
  const result = await waitFor(executor, started.operationId);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.exitCode, 0);
  assert.equal(result.errorCode, null);
  assert.match(result.artifact.path, /^build\/[a-f0-9]{32}\/program$/);
  assert.match(result.artifact.sha256, /^[a-f0-9]{64}$/);
  assert.ok(result.artifact.size > 0);
  const argv = JSON.parse(await readFile(path.join(root, result.artifact.path), 'utf8'));
  assert.deepEqual(argv, ['-Vgcc_ntox86_64', '-o', path.join(root, result.artifact.path), path.join(root, 'src', 'hello.c')]);
});

test('returns compiler failure and diagnostics without an artifact', linuxOnly, async t => {
  const { root, executor } = await fixture(t);
  await writeFile(path.join(root, 'src', 'hello.c'), 'FAIL');
  const started = await executor.call('qnx_compile_c', { source: 'src/hello.c' });
  const result = await waitFor(executor, started.operationId);
  assert.equal(result.state, 'failed');
  assert.equal(result.exitCode, 2);
  assert.equal(result.errorCode, 'COMMAND_FAILED');
  assert.match(result.stderr, /FAKE compilation error/);
  assert.equal(result.artifact, undefined);
});

test('bounds stdout and stderr independently and reports truncation', linuxOnly, async t => {
  const { root, executor } = await fixture(t);
  await writeFile(path.join(root, 'src', 'hello.c'), 'NOISE');
  const started = await executor.call('qnx_compile_c', { source: 'src/hello.c' });
  const result = await waitFor(executor, started.operationId);
  assert.equal(Buffer.byteLength(result.stdout), 32768);
  assert.equal(Buffer.byteLength(result.stderr), 32768);
  assert.equal(result.truncated, true);
  assert.equal(result.errorCode, 'OUTPUT_LIMIT');
  assert.equal(result.state, 'failed');
});

test('enforces a deadline and terminates a fake compiler that ignores SIGTERM', linuxOnly, async t => {
  const { root, executor } = await fixture(t, { deadlines: { qnx_compile_c: 300 }, graceMs: 30 });
  await writeFile(path.join(root, 'src', 'hello.c'), 'WAIT');
  const started = await executor.call('qnx_compile_c', { source: 'src/hello.c' });
  const result = await waitFor(executor, started.operationId);
  assert.equal(result.state, 'timed_out');
  assert.equal(result.errorCode, 'TIMEOUT');
  assert.equal(result.artifact, undefined);
});

test('cancellation is a request before confirmed termination and releases the lock', linuxOnly, async t => {
  const { root, executor } = await fixture(t, { graceMs: 30 });
  await writeFile(path.join(root, 'src', 'hello.c'), 'WAIT');
  const started = await executor.call('qnx_compile_c', { source: 'src/hello.c' });
  await waitFor(executor, started.operationId, result => result.stdout.includes('FAKE READY'));
  await rejectsCode(() => executor.call('qnx_compile_c', { source: 'src/hello.c' }), 'BUSY');
  const requested = await executor.call('qnx_operation_cancel', { operationId: started.operationId });
  assert.equal(requested.cancellationAccepted, true);
  assert.equal(requested.state, 'running');
  const result = await waitFor(executor, started.operationId);
  assert.equal(result.state, 'cancelled');
  assert.equal(result.errorCode, 'CANCELLED');
  await writeFile(path.join(root, 'src', 'hello.c'), 'int main(void) { return 0; }');
  const next = await executor.call('qnx_compile_c', { source: 'src/hello.c' });
  assert.equal((await waitFor(executor, next.operationId)).state, 'succeeded');
});

test('rejects a source symlink outside the workspace', linuxOnly, async t => {
  const { base, root, executor } = await fixture(t);
  const external = path.join(base, 'external.c');
  await writeFile(external, 'int main(void) { return 0; }');
  await symlink(external, path.join(root, 'src', 'escape.c'));
  const started = await executor.call('qnx_compile_c', { source: 'src/escape.c' });
  const result = await waitFor(executor, started.operationId);
  assert.equal(result.errorCode, 'OUTSIDE_WORKSPACE');
  assert.equal(result.artifact, undefined);
});

test('rejects a build directory symlink outside the workspace', linuxOnly, async t => {
  const { base, root, executor } = await fixture(t);
  const external = path.join(base, 'external-build');
  await mkdir(external);
  await symlink(external, path.join(root, 'build'));
  const started = await executor.call('qnx_compile_c', { source: 'src/hello.c' });
  assert.equal((await waitFor(executor, started.operationId)).errorCode, 'OUTSIDE_WORKSPACE');
});

test('runs both fixed toolchain information commands', linuxOnly, async t => {
  const { executor } = await fixture(t);
  const started = await executor.call('qnx_toolchain_info', {});
  const result = await waitFor(executor, started.operationId);
  assert.equal(result.state, 'succeeded');
  assert.match(result.stdout, /FAKE qcc version/);
  assert.match(result.stdout, /FAKE gcc_ntox86_64/);
});

test('reports a missing compiler', linuxOnly, async t => {
  const { bin, executor } = await fixture(t);
  await rm(path.join(bin, 'qcc'));
  const started = await executor.call('qnx_toolchain_info', {});
  assert.equal((await waitFor(executor, started.operationId)).errorCode, 'TOOL_MISSING');
});

test('image tools fail closed without invoking fake mkqnximage', linuxOnly, async t => {
  const { marker, executor } = await fixture(t);
  for (const name of ['qnx_image_build', 'qnx_image_start', 'qnx_image_ip', 'qnx_image_stop']) {
    await rejectsCode(() => executor.call(name, {}), 'UNSAFE_CONFIGURATION');
  }
  await assert.rejects(() => access(marker), error => error.code === 'ENOENT');
});

test('unknown operation IDs cannot be queried or cancelled', linuxOnly, async t => {
  const { executor } = await fixture(t);
  for (const name of ['qnx_operation_status', 'qnx_operation_cancel']) {
    await rejectsCode(() => executor.call(name, { operationId: 'a'.repeat(32) }), 'UNKNOWN_OPERATION');
  }
});

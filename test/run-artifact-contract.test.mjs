import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TOOLS, DEADLINES_MS, validateArguments } from '../src/contracts.mjs';
import { loadRunConfig } from '../src/run-config.mjs';

const id = 'a'.repeat(32);
const rejectsCode = code => error => error?.code === code;

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'qnx-run-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('run advertises only a compilation reference and a bounded total deadline', () => {
  const tool = TOOLS.find(item => item.name === 'qnx_run_artifact');
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['compileOperationId']);
  assert.deepEqual(tool.inputSchema.required, ['compileOperationId']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(DEADLINES_MS.qnx_run_artifact, 240000);
  assert.deepEqual(validateArguments(tool.name, { compileOperationId: id }), { compileOperationId: id });
});

test('run rejects paths, commands, malformed IDs and additional properties', () => {
  for (const supplied of [undefined, null, [], {},
    { compileOperationId: '/tmp/program' },
    { compileOperationId: 'A'.repeat(32) },
    { compileOperationId: 'a'.repeat(31) },
    { compileOperationId: id + '\n' },
    { compileOperationId: 123 },
    { compileOperationId: id, path: '/tmp/program' },
    { compileOperationId: id, argv: [] },
    { compileOperationId: id, command: 'anything' },
    Object.assign(Object.create({ inherited: true }), { compileOperationId: id }),
  ]) {
    assert.throws(() => validateArguments('qnx_run_artifact', supplied), rejectsCode('INVALID_INPUT'));
  }
});

test('run rejects accessors without evaluating them and rejects symbol properties', () => {
  let evaluated = false;
  const supplied = Object.defineProperty({}, 'compileOperationId', {
    enumerable: true, get() { evaluated = true; return id; },
  });
  assert.throws(() => validateArguments('qnx_run_artifact', supplied), rejectsCode('INVALID_INPUT'));
  assert.equal(evaluated, false);
  assert.throws(() => validateArguments('qnx_run_artifact', {
    compileOperationId: id, [Symbol('extra')]: true,
  }), rejectsCode('INVALID_INPUT'));
});

test('run configuration is disabled and immutable when absent', async () => {
  const config = await loadRunConfig({});
  assert.deepEqual(config, { version: 1, enabled: false });
  assert.equal(Object.isFrozen(config), true);
});

test('run configuration accepts exactly the operator schema without accessing the template', async t => {
  const root = await fixture(t);
  const filename = path.join(root, 'run.json');
  for (const enabled of [false, true]) {
    const expected = { version: 1, enabled, templateDir: path.join(root, 'absent-template') };
    await writeFile(filename, JSON.stringify(expected));
    const actual = await loadRunConfig({ QNX_MCP_RUN_CONFIG: filename });
    assert.deepEqual(actual, expected);
    assert.equal(Object.isFrozen(actual), true);
  }
});

test('run configuration rejects relative paths and missing files', async t => {
  const root = await fixture(t);
  for (const filename of ['relative.json', '', path.join(root, 'missing.json')]) {
    await assert.rejects(loadRunConfig({ QNX_MCP_RUN_CONFIG: filename }), rejectsCode('UNSAFE_CONFIGURATION'));
  }
});

test('run configuration rejects malformed, oversized and non-schema data', async t => {
  const root = await fixture(t);
  const filename = path.join(root, 'run.json');
  const valid = { version: 1, enabled: false, templateDir: root };
  for (const text of ['{', 'null', '[]', ' '.repeat(4097),
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, enabled: 'false' }),
    JSON.stringify({ version: 1, enabled: false }),
    JSON.stringify({ ...valid, templateDir: 'relative' }),
    JSON.stringify({ ...valid, templateDir: root + '\0' }),
    JSON.stringify({ ...valid, unexpected: true }),
  ]) {
    await writeFile(filename, text);
    await assert.rejects(loadRunConfig({ QNX_MCP_RUN_CONFIG: filename }), rejectsCode('UNSAFE_CONFIGURATION'));
  }
  await writeFile(filename, Buffer.from([0xff]));
  await assert.rejects(loadRunConfig({ QNX_MCP_RUN_CONFIG: filename }), rejectsCode('UNSAFE_CONFIGURATION'));
});

test('run configuration rejects a symbolic-link configuration file', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t);
  const filename = path.join(root, 'run.json');
  const link = path.join(root, 'link.json');
  await writeFile(filename, JSON.stringify({ version: 1, enabled: true, templateDir: root }));
  await symlink(filename, link);
  await assert.rejects(loadRunConfig({ QNX_MCP_RUN_CONFIG: link }), rejectsCode('UNSAFE_CONFIGURATION'));
});

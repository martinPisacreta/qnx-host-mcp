import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadImageConfig } from '../src/image-config.mjs';
import { Executor } from '../src/executor.mjs';

const imageTools = ['qnx_image_build', 'qnx_image_start', 'qnx_image_ip', 'qnx_image_stop'];
const unsafe = error => error.code === 'UNSAFE_CONFIGURATION';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'qnx-image-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, filename: path.join(root, 'images.json') };
}

test('missing configuration defaults to disabled', async () => {
  const config = await loadImageConfig({});
  assert.deepEqual(config, { version: 1, enabled: false });
  assert.equal(Object.isFrozen(config), true);
});

for (const mode of ['absent', 'disabled', 'enabled']) {
  test(`all image tools remain blocked with ${mode} configuration`, async t => {
    const { root, filename } = await fixture(t);
    const env = { QNX_MCP_WORKSPACE: root, PATH: '' };
    if (mode !== 'absent') {
      await writeFile(filename, JSON.stringify({ version: 1, enabled: mode === 'enabled' }));
      env.QNX_MCP_IMAGE_CONFIG = filename;
    }
    const executor = await Executor.create({ env });
    t.after(() => executor.close());
    assert.equal(executor.imageConfig.enabled, mode === 'enabled');
    for (const name of imageTools) {
      await assert.rejects(() => executor.call(name, {}), unsafe);
      await assert.rejects(() => executor.call(name, { enabled: true }), error => error.code === 'INVALID_INPUT');
    }
    assert.equal(executor.operations.size, 0);
  });
}

test('invalid operator configuration prevents executor startup', async t => {
  const { root, filename } = await fixture(t);
  for (const config of [null, [], {}, { version: 1 },
    { version: 2, enabled: true }, { version: 1, enabled: 'true' },
    { version: 1, enabled: true, isolationVerified: true }]) {
    await writeFile(filename, JSON.stringify(config));
    await assert.rejects(() => Executor.create({ env: {
      QNX_MCP_WORKSPACE: root, QNX_MCP_IMAGE_CONFIG: filename,
    } }), unsafe);
  }
});

test('rejects relative, missing and directory configuration paths', async t => {
  const { root, filename } = await fixture(t);
  for (const value of ['images.json', '', filename, root]) {
    await assert.rejects(() => loadImageConfig({ QNX_MCP_IMAGE_CONFIG: value }), unsafe);
  }
});

test('rejects malformed, oversized and invalid UTF-8 configuration', async t => {
  const { filename } = await fixture(t);
  for (const value of ['{', ' '.repeat(4097), Buffer.from([0xff])]) {
    await writeFile(filename, value);
    await assert.rejects(() => loadImageConfig({ QNX_MCP_IMAGE_CONFIG: filename }), unsafe);
  }
});

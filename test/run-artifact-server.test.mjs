import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Executor } from '../src/executor.mjs';
import { createMcpServer } from '../src/server.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'qnx-run-mcp-'));
  let executor;
  let server;
  let client;
  t.after(async () => {
    try {
      await client?.close();
      await executor?.close();
      await server?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  executor = await Executor.create({
    env: { QNX_MCP_WORKSPACE: root, PATH: '' },
  });
  server = createMcpServer(executor);
  client = new Client({ name: 'run-artifact-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { root, executor, client };
}

test('MCP advertises run with only a compilation reference', async t => {
  const { client } = await fixture(t);
  const { tools } = await client.listTools();
  const run = tools.find(tool => tool.name === 'qnx_run_artifact');
  assert.ok(run);
  assert.deepEqual(Object.keys(run.inputSchema.properties), ['compileOperationId']);
  assert.deepEqual(run.inputSchema.required, ['compileOperationId']);
  assert.equal(run.inputSchema.additionalProperties, false);
  assert.match(run.description, /disabled by default/i);
  assert.deepEqual(
    tools.filter(tool => tool.name.startsWith('qnx_image_')).map(tool => tool.name).sort(),
    ['qnx_image_build', 'qnx_image_ip', 'qnx_image_start', 'qnx_image_stop'],
  );
});

test('disabled run returns a structured MCP error without creating work', async t => {
  const { root, executor, client } = await fixture(t);
  const before = await readdir(root);
  const response = await client.callTool({
    name: 'qnx_run_artifact',
    arguments: { compileOperationId: 'a'.repeat(32) },
  });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.state, 'failed');
  assert.equal(response.structuredContent.errorCode, 'UNSAFE_CONFIGURATION');
  assert.equal(response.structuredContent.exitCode, null);
  assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
  assert.equal(executor.operations.size, 0);
  assert.equal(executor.mutatingOperation, null);
  assert.deepEqual(await readdir(root), before);
});

test('MCP rejects caller-supplied execution options', async t => {
  const { client, executor } = await fixture(t);
  const response = await client.callTool({
    name: 'qnx_run_artifact',
    arguments: { compileOperationId: 'a'.repeat(32), command: 'unaccepted' },
  });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.errorCode, 'INVALID_INPUT');
  assert.equal(executor.operations.size, 0);
});

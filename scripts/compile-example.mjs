#!/usr/bin/env node
// Compile one example through the MCP server, the same way an AI client would.
// Usage: node scripts/compile-example.mjs examples/<name> src/<file>.c
// Requires the licensed QNX SDK environment (qnxsdp-env.sh) in the calling shell.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = fileURLToPath(new URL('../', import.meta.url));
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const [exampleDir, source] = process.argv.slice(2);
if (!exampleDir || !/^src\/[A-Za-z0-9_-]+[.]c$/.test(source ?? '')) {
  console.error('Usage: node scripts/compile-example.mjs examples/<name> src/<file>.c');
  process.exit(2);
}

const workspace = await realpath(path.resolve(project, exampleDir));
const environment = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
delete environment.QNX_MCP_IMAGE_CONFIG;
environment.QNX_MCP_WORKSPACE = workspace;

const transport = new StdioClientTransport({
  command: process.execPath, args: [path.join(project, 'src/server.mjs')],
  cwd: project, env: environment, stderr: 'pipe',
});
const client = new Client({ name: 'qnx-compile-example', version: '0.1.0' }, { capabilities: {} });

async function call(name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 10000 });
  return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
}

let exitCode = 0;
try {
  await client.connect(transport, { timeout: 10000 });
  transport.stderr?.resume();
  let result = await call('qnx_compile_c', { source });
  const deadline = Date.now() + 135000;
  while (!terminal.has(result.state)) {
    if (Date.now() >= deadline) throw new Error('Polling deadline exceeded.');
    await delay(50);
    result = await call('qnx_operation_status', { operationId: result.operationId });
  }
  if (result.state !== 'succeeded' || result.exitCode !== 0) throw new Error(`Compile ${result.errorCode ?? result.state}`);
  const artifact = path.join(workspace, result.artifact.path);
  const bytes = await readFile(artifact);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== result.artifact.size || sha256 !== result.artifact.sha256) {
    throw new Error('Artifact size/hash differs from server evidence.');
  }
  console.log(JSON.stringify({
    tool: 'qnx_compile_c', source, state: result.state, exitCode: result.exitCode,
    artifact: { path: result.artifact.path, sizeBytes: bytes.length, sha256, independentlyVerified: true },
  }, null, 2));
} catch (error) {
  console.error(`compile-example: ${error.message}`);
  exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
process.exit(exitCode);

#!/usr/bin/env node
// Compile one example and run it in QEMU through the MCP server, the same way an AI client would:
// qnx_compile_c, then qnx_run_artifact with the compilation operation ID, polling qnx_operation_status.
// Usage: node scripts/run-example.mjs examples/<name> src/<file>.c
// Requires the licensed QNX SDK environment (qnxsdp-env.sh) and an operator run configuration:
//   QNX_MCP_RUN_CONFIG=/absolute/run.json with { "version": 1, "enabled": true, "templateDir": "/absolute/template" }
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = fileURLToPath(new URL('../', import.meta.url));
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const [exampleDir, source] = process.argv.slice(2);
if (!exampleDir || !/^src\/[A-Za-z0-9_-]+[.]c$/.test(source ?? '')) {
  console.error('Usage: node scripts/run-example.mjs examples/<name> src/<file>.c');
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
const client = new Client({ name: 'qnx-run-example', version: '0.1.0' }, { capabilities: {} });

async function call(name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 10000 });
  return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
}

async function settle(first, limitMs) {
  let result = first;
  const deadline = Date.now() + limitMs;
  while (!terminal.has(result.state)) {
    if (Date.now() >= deadline) throw new Error('Polling deadline exceeded.');
    await delay(200);
    result = await call('qnx_operation_status', { operationId: result.operationId });
  }
  return result;
}

let exitCode = 0;
try {
  await client.connect(transport, { timeout: 10000 });
  transport.stderr?.resume();
  const compiled = await settle(await call('qnx_compile_c', { source }), 135000);
  if (compiled.state !== 'succeeded' || compiled.exitCode !== 0) throw new Error(`Compile ${compiled.errorCode ?? compiled.state}`);
  const ran = await settle(await call('qnx_run_artifact', { compileOperationId: compiled.operationId }), 300000);
  const markers = typeof ran.console === 'string'
    ? ran.console.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.trim() !== '').slice(-8)
    : [];
  console.log(JSON.stringify({
    source,
    compile: { state: compiled.state, sizeBytes: compiled.artifact?.size, sha256: compiled.artifact?.sha256 },
    run: {
      state: ran.state, errorCode: ran.errorCode ?? null, exitCode: ran.exitCode ?? null,
      buildExitCode: ran.buildExitCode ?? null, qemuExitCode: ran.qemuExitCode ?? null,
      timings: ran.timings ?? null, consoleTruncated: ran.consoleTruncated ?? null,
    },
    consoleTail: markers,
  }, null, 2));
  if (ran.state !== 'succeeded' || ran.exitCode !== 0) exitCode = 1;
} catch (error) {
  console.error(`run-example: ${error.message}`);
  exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
process.exit(exitCode);

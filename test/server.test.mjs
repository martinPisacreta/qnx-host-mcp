import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url));

test('stdio initialization, discovery and rejected requests use MCP responses', { timeout: 10000 }, async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'qnx-mcp-stdio-'));
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, QNX_MCP_WORKSPACE: workspace },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  let diagnostics = '';
  child.stderr.on('data', chunk => {
    diagnostics = (diagnostics + chunk.toString()).slice(-4096);
  });
  const pending = new Map();
  let nextId = 1;
  let protocolFailure = null;
  const failPending = error => {
    protocolFailure = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); }
    catch {
      failPending(new Error('Server emitted non-JSON output on protocol stdout.'));
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  child.on('error', failPending);
  const exited = new Promise(resolve => child.once('close', (code, signal) => {
    failPending(new Error(`Server closed: ${code}/${signal}. ${diagnostics}`));
    resolve();
  }));
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
    await exited;
    clearTimeout(timer);
    lines.close();
    await rm(workspace, { recursive: true, force: true });
  });

  function request(method, params) {
    if (protocolFailure) return Promise.reject(protocolFailure);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}. ${diagnostics}`));
      }, 3000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  const initialized = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'qnx-mcp-test', version: '1.0.0' },
  });
  assert.equal(initialized.serverInfo.name, 'qnx-host-mcp');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await request('tools/list', {});
  assert.equal(listed.tools.length, 8);
  for (const tool of listed.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
  }

  for (const [name, args, expected] of [
    ['qnx_compile_c', { source: 'src/hello.c', flags: ['-shared'] }, 'INVALID_INPUT'],
    ['qnx_image_start', {}, 'UNSAFE_CONFIGURATION'],
    ['qnx_operation_status', { operationId: 'a'.repeat(32) }, 'UNKNOWN_OPERATION'],
  ]) {
    const result = await request('tools/call', { name, arguments: args });
    assert.equal(result.isError, true);
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.errorCode, expected);
    assert.equal(envelope.state, 'failed');
    assert.deepEqual(result.structuredContent, envelope);
  }
});

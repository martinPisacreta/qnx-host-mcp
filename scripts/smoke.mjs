#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = fileURLToPath(new URL('../', import.meta.url));
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

function options(argv) {
  const result = { fake: false, evidenceRoot: path.join(project, 'evidence') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fake') result.fake = true;
    else if (argv[i] === '--evidence-root' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      result.evidenceRoot = path.resolve(argv[++i]);
    } else throw new Error('Usage: node scripts/smoke.mjs [--fake] [--evidence-root DIRECTORY]');
  }
  return result;
}

// Same fake qcc command protocol as test/executor.test.mjs. The fixture is
// private to that test module; importing it would execute its test suite.
async function fakeEnvironment(base) {
  const bin = path.join(base, 'bin');
  const workspace = path.join(base, 'workspace');
  await mkdir(bin);
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await copyFile(path.join(project, 'examples/hello/src/hello.c'), path.join(workspace, 'src/hello.c'));
  await writeFile(path.join(bin, 'qcc'), `#!${process.execPath}
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
`, { mode: 0o700 });
  return { workspace: await realpath(workspace), env: { PATH: bin } };
}

function markdown(report) {
  const body = JSON.stringify(report, null, 2);
  const fence = '`'.repeat(Math.max(3, ...Array.from(body.matchAll(/`+/g), match => match[0].length + 1)));
  return [
    '# QNX MCP smoke evidence',
    '',
    report.simulated
      ? '**SIMULATED: fake compiler; this report does not demonstrate QNX compilation or execution.**'
      : '**Real PATH run: inspect compiler output and successful artifact verification before claiming QNX compilation.**',
    '',
    `Success: ${report.success}`,
    '',
    'This smoke compiles a source file. It does not execute the artifact or call image tools.',
    'Compiler arguments are reconstructed from the fixed executor contract; the server does not expose an argv trace. Fake mode additionally compares them with the fixture artifact.',
    '',
    fence + 'json',
    body,
    fence,
    '',
  ].join('\n');
}

async function main() {
  const config = options(process.argv.slice(2));
  if (config.fake && process.platform === 'win32') throw new Error('Fake mode requires Linux/WSL.');
  const startedAt = new Date().toISOString();
  await mkdir(config.evidenceRoot, { recursive: true });
  const directory = await mkdtemp(path.join(config.evidenceRoot, startedAt.replaceAll(':', '-') + '-'));
  const report = {
    schemaVersion: 1, mode: config.fake ? 'fake' : 'real', simulated: config.fake,
    startedAt, finishedAt: null, success: false, toolsListed: [], toolsCalled: [],
    toolchain: null, compile: null, artifact: null, error: null,
  };
  let temporary;
  let client;
  let transport;
  let failure;
  try {
    let workspace = await realpath(path.join(project, 'examples/hello'));
    let environment = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
    if (config.fake) {
      temporary = await mkdtemp(path.join(tmpdir(), 'qnx-smoke-'));
      const fake = await fakeEnvironment(temporary);
      workspace = fake.workspace;
      environment = { ...environment, ...fake.env };
    }
    // An unrelated operator image configuration must not influence this compile-only run.
    delete environment.QNX_MCP_IMAGE_CONFIG;
    environment.QNX_MCP_WORKSPACE = workspace;
    transport = new StdioClientTransport({
      command: process.execPath, args: [path.join(project, 'src/server.mjs')],
      cwd: project, env: environment, stderr: 'pipe',
    });
    client = new Client({ name: 'qnx-smoke', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport, { timeout: 10000 });
    // Drain server diagnostics without retaining arbitrary host details.
    transport.stderr?.resume();
    let cursor;
    do {
      const listed = await client.listTools(cursor ? { cursor } : {}, { timeout: 10000 });
      report.toolsListed.push(...listed.tools.map(tool => tool.name));
      cursor = listed.nextCursor;
      if (report.toolsListed.length > 100) throw new Error('Unexpected tool pagination.');
    } while (cursor);
    for (const required of ['qnx_toolchain_info', 'qnx_compile_c', 'qnx_operation_status']) {
      if (!report.toolsListed.includes(required)) throw new Error(`Missing tool: ${required}`);
    }

    async function call(name, args) {
      if (!['qnx_toolchain_info', 'qnx_compile_c', 'qnx_operation_status'].includes(name)) {
        throw new Error('Unexpected smoke tool.');
      }
      report.toolsCalled.push(name);
      const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 10000 });
      const result = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
      if (!result || typeof result.state !== 'string') throw new Error('Malformed MCP operation result.');
      return result;
    }

    async function operation(name, args, limitMs, field) {
      let result = await call(name, args);
      report[field] = result;
      const deadline = Date.now() + limitMs;
      if (!/^[a-f0-9]{32}$/.test(result.operationId)) throw new Error('Invalid operation ID.');
      do {
        if (Date.now() >= deadline) throw new Error(`${name}: polling deadline exceeded.`);
        await delay(50);
        result = await call('qnx_operation_status', { operationId: result.operationId });
        report[field] = result;
      } while (!terminal.has(result.state));
      if (result.state !== 'succeeded' || result.exitCode !== 0 || result.truncated) {
        throw new Error(`${name}: ${result.errorCode ?? result.state}`);
      }
      return result;
    }

    await operation('qnx_toolchain_info', {}, 40000, 'toolchain');
    report.toolchain.commands = [['--version'], ['-V']];
    const compiled = await operation('qnx_compile_c', { source: 'src/hello.c' }, 135000, 'compile');
    const metadata = compiled.artifact;
    if (!metadata || !/^build\/[a-f0-9]{32}\/program$/.test(metadata.path)) {
      throw new Error('Missing or unexpected artifact path.');
    }
    const artifactPath = path.join(workspace, metadata.path);
    if (await realpath(artifactPath) !== artifactPath) throw new Error('Unexpected artifact symlink.');
    const bytes = await readFile(artifactPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!bytes.length || bytes.length !== metadata.size || sha256 !== metadata.sha256) {
      throw new Error('Artifact size/hash differs from server evidence.');
    }
    report.compile.arguments = ['-Vgcc_ntox86_64', '-o', metadata.path, 'src/hello.c'];
    report.compile.argumentRepresentation = 'workspace-relative paths; reconstructed from fixed executor contract';
    report.compile.executedArguments = ['-Vgcc_ntox86_64', '-o', artifactPath, path.join(workspace, 'src/hello.c')];
    report.compile.executedArgumentsSource = 'reconstructed; not a server-provided execution trace';
    if (config.fake) {
      const recorded = JSON.parse(bytes.toString('utf8'));
      if (JSON.stringify(recorded) !== JSON.stringify(report.compile.executedArguments)) {
        throw new Error('Fake compiler recorded unexpected arguments.');
      }
      report.compile.fakeArgumentsVerified = true;
    }
    report.artifact = {
      path: metadata.path, sizeBytes: bytes.length, sha256, independentlyVerified: true,
      retained: !config.fake,
      note: config.fake ? 'Simulated fixture output; temporary workspace removed after run.' : 'Artifact remains in the examples/hello workspace; it was not executed.',
    };
    report.success = true;
  } catch (error) {
    failure = error;
    report.error = error.message;
  } finally {
    try {
      if (client) await client.close();
    } catch (error) {
      failure ??= error;
      report.success = false;
      report.error ??= 'MCP client shutdown failed.';
    }
    try {
      if (transport) await transport.close();
      if (temporary) await rm(temporary, { recursive: true, force: true });
    } catch (error) {
      failure ??= error;
      report.success = false;
      report.error ??= 'Smoke cleanup failed.';
    }
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(path.join(directory, 'report.md'), markdown(report));
    process.stdout.write(`Evidence: ${directory}\n`);
  }
  if (failure) throw failure;
}

main().catch(error => {
  process.stderr.write(`QNX smoke failed: ${error.message}\n`);
  process.exitCode = 1;
});

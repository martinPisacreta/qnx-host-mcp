import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/smoke.mjs', import.meta.url));

test('fake MCP smoke produces clearly simulated JSON and Markdown evidence', {
  timeout: 30000,
  skip: process.platform === 'win32' ? 'Fake executables require Linux/WSL.' : false,
}, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'qnx-smoke-test-'));
  try {
    const evidenceRoot = path.join(temporary, 'evidence');
    await execute(process.execPath, [script, '--fake', '--evidence-root', evidenceRoot], {
      cwd: temporary,
      encoding: 'utf8',
      timeout: 25000,
      maxBuffer: 1024 * 1024,
    });

    const directories = (await readdir(evidenceRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory());
    assert.equal(directories.length, 1);
    assert.match(directories[0].name, /^\d{4}-\d{2}-\d{2}/);
    const directory = path.join(evidenceRoot, directories[0].name);
    const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
    const markdown = await readFile(path.join(directory, 'report.md'), 'utf8');

    assert.equal(report.mode, 'fake');
    assert.equal(report.simulated, true);
    assert.equal(report.success, true);
    assert.ok(Number.isFinite(Date.parse(report.startedAt)));
    assert.ok(Number.isFinite(Date.parse(report.finishedAt)));
    assert.ok(report.toolsListed.includes('qnx_toolchain_info'));
    assert.ok(report.toolsListed.includes('qnx_compile_c'));
    for (const name of ['qnx_toolchain_info', 'qnx_compile_c', 'qnx_operation_status']) {
      assert.ok(report.toolsCalled.includes(name), `Missing MCP call: ${name}`);
    }
    assert.equal(report.toolsCalled.some(name => name.startsWith('qnx_image_')), false);
    assert.equal(report.toolchain.state, 'succeeded');
    assert.equal(report.toolchain.exitCode, 0);
    assert.equal(typeof report.toolchain.stdout, 'string');
    assert.ok(report.toolchain.stdout.trim().length > 0);
    assert.equal(report.compile.state, 'succeeded');
    assert.equal(report.compile.exitCode, 0);
    assert.ok(Array.isArray(report.compile.arguments));
    assert.ok(report.compile.arguments.includes('src/hello.c'));
    assert.ok(Number.isSafeInteger(report.artifact.sizeBytes));
    assert.ok(report.artifact.sizeBytes > 0);
    assert.match(report.artifact.sha256, /^[a-f0-9]{64}$/);
    assert.match(markdown, /simulated/i);
    assert.ok(markdown.includes(report.artifact.sha256));
    assert.ok(markdown.includes(String(report.artifact.sizeBytes)));
    assert.ok(markdown.includes('src/hello.c'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

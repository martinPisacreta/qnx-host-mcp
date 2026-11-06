import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { captureOwnedGroup, captureOwnedDescendant, readOwnedProcessSockets } from '../src/proc-sockets.mjs';

 test('verifies a live descendant and rejects an unrelated process', { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const program = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    child.once('spawn', () => process.stdout.write(String(child.pid) + String.fromCharCode(10)));
    setInterval(() => {}, 1000);
  `;
  const launcher = spawn(process.execPath, ['-e', program], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => {
    launcher.once('close', resolve);
    launcher.once('error', resolve);
  });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const unrelatedClosed = new Promise(resolve => {
    unrelated.once('close', resolve);
    unrelated.once('error', resolve);
  });
  try {
    const pid = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Missing child PID')), 3000);
      launcher.once('error', error => { clearTimeout(timer); reject(error); });
      launcher.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('\n')) { clearTimeout(timer); resolve(Number(output.trim())); }
      });
    });
    const group = await captureOwnedGroup(launcher.pid);
    const target = await captureOwnedDescendant(group, pid);
    assert.equal(target.pid, pid);
    // The child may still be closing startup descriptors; retry only this positive observation.
    let sockets;
    for (let attempt = 0; ; attempt++) {
      try {
        sockets = await readOwnedProcessSockets(group, target);
        break;
      } catch (error) {
        if (attempt === 4 ||
            error.message !==
            'Owned process socket observation could not be established.') throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    assert.deepEqual(sockets.ownedInodes, []);
    assert.equal(typeof sockets.tcpText, 'string');
    assert.equal(typeof sockets.tcp6Text, 'string');
    await assert.rejects(captureOwnedDescendant(group, unrelated.pid));
    await assert.rejects(captureOwnedDescendant(group, launcher.pid));
    await assert.rejects(readOwnedProcessSockets(group, { ...target, startTime: 'invalid' }));
    assert.equal(unrelated.exitCode, null);
  } finally {
    try { if (launcher.pid) process.kill(-launcher.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    unrelated.kill('SIGKILL');
    await Promise.all([closed, unrelatedClosed]);
  }
});

import { readFile, readdir, readlink } from 'node:fs/promises';

// Internal Linux observation only; identities never come from MCP arguments.
function unknown() {
  return new Error('Owned process socket observation could not be established.');
}

async function identity(pid, requireLive = true) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw unknown();
  const text = await readFile(`/proc/${pid}/stat`, 'utf8');
  const end = text.lastIndexOf(')');
  if (end < 0 || !text.startsWith(`${pid} (`)) throw unknown();
  const fields = text.slice(end + 1).trim().split(/\s+/);
  if (fields.length < 20 || !/^\d+$/.test(fields[19])) throw unknown();
  const parent = Number(fields[1]);
  const group = Number(fields[2]);
  const session = Number(fields[3]);
  if (!Number.isSafeInteger(parent) || parent < 0 ||
      !Number.isSafeInteger(group) || !Number.isSafeInteger(session) ||
      (requireLive && ['Z', 'X', 'x'].includes(fields[0]))) throw unknown();
  return { pid, parent, group, session, startTime: fields[19] };
}

function same(left, right) {
  return left.pid === right.pid && left.group === right.group &&
    left.session === right.session && left.startTime === right.startTime;
}

// Capture immediately after spawning a detached, server-owned Linux child.
export async function captureOwnedGroup(pid) {
  if (process.platform !== 'linux') throw unknown();
  const token = await identity(pid);
  if (token.group !== pid || token.session !== pid) throw unknown();
  return Object.freeze(token);
}

async function members(token) {
  const entries = await readdir('/proc');
  if (entries.length > 32768) throw unknown();
  const found = [];
  for (const entry of entries) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid <= 1 || pid === process.pid) continue;
    let current;
    // Unrelated zombies must not invalidate enumeration of the owned group.
    // Parse their identity, then require liveness for every matching member.
    try { current = await identity(pid, false); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
      throw error;
    }
    if (current.group === token.group && current.session === token.session) {
      const verified = await identity(pid);
      if (!same(current, verified)) throw unknown();
      found.push(verified);
      if (found.length > 1024) throw unknown();
    }
  }
  return found.sort((a, b) => a.pid - b.pid);
}

export async function readOwnedGroupSockets(token) {
  try {
    if (process.platform !== 'linux' || !token ||
        token.group !== token.pid || token.session !== token.pid ||
        !same(token, await identity(token.pid))) throw unknown();
    const before = await members(token);
    if (!before.some(item => same(item, token))) throw unknown();
    const owned = new Set();
    for (const member of before) {
      if (!same(member, await identity(member.pid))) throw unknown();
      const directory = `/proc/${member.pid}/fd`;
      const descriptors = await readdir(directory);
      if (descriptors.length > 16384) throw unknown();
      for (const descriptor of descriptors) {
        const target = await readlink(`${directory}/${descriptor}`);
        const match = /^socket:\[([0-9]+)\]$/.exec(target);
        if (match) owned.add(match[1]);
      }
      if (!same(member, await identity(member.pid))) throw unknown();
    }
    const tcpText = await readFile(`/proc/${token.pid}/net/tcp`, 'utf8');
    const tcp6Text = await readFile(`/proc/${token.pid}/net/tcp6`, 'utf8');
    const after = await members(token);
    if (!same(token, await identity(token.pid)) ||
        before.length !== after.length ||
        before.some((item, index) => !same(item, after[index]))) throw unknown();
    return { tcpText, tcp6Text, ownedInodes: [...owned] };
  } catch {
    // Inconsistent observations must never become an empty, safe socket set.
    throw unknown();
  }
}

export async function captureOwnedDescendant(launcher, pid) {
  try {
    if (process.platform !== 'linux' || !launcher ||
        launcher.pid !== launcher.group || launcher.pid !== launcher.session ||
        pid === launcher.pid || !same(launcher, await identity(launcher.pid))) {
      throw unknown();
    }
    const target = await identity(pid);
    const chain = [];
    const seen = new Set();
    let current = target;
    while (current.pid !== launcher.pid) {
      if (chain.length >= 128 || seen.has(current.pid) ||
          current.group !== launcher.group || current.session !== launcher.session ||
          current.parent <= 1) throw unknown();
      seen.add(current.pid);
      chain.push(current);
      current = await identity(current.parent);
    }
    if (!same(current, launcher)) throw unknown();
    for (const observed of chain) {
      const checked = await identity(observed.pid);
      if (!same(observed, checked) || observed.parent !== checked.parent) throw unknown();
    }
    if (!same(launcher, await identity(launcher.pid))) throw unknown();
    return Object.freeze(target);
  } catch {
    throw unknown();
  }
}

export async function readOwnedProcessSockets(launcher, target) {
  try {
    if (!target || !same(target, await captureOwnedDescendant(launcher, target.pid))) {
      throw unknown();
    }
    const directory = `/proc/${target.pid}/fd`;
    const descriptors = await readdir(directory);
    if (descriptors.length > 16384) throw unknown();
    const owned = new Set();
    for (const descriptor of descriptors) {
      const link = await readlink(`${directory}/${descriptor}`);
      const match = /^socket:\[([0-9]+)\]$/.exec(link);
      if (match) owned.add(match[1]);
    }
    const tcpText = await readFile(`/proc/${target.pid}/net/tcp`, 'utf8');
    const tcp6Text = await readFile(`/proc/${target.pid}/net/tcp6`, 'utf8');
    if (!same(target, await captureOwnedDescendant(launcher, target.pid))) throw unknown();
    return { tcpText, tcp6Text, ownedInodes: [...owned] };
  } catch {
    throw unknown();
  }
}

// Liveness observation for an identity already captured internally.
// This does not authorize signalling a PID or establish current ancestry.
// Zombies still exist until reaped and must not count as confirmed removal.
export async function ownedProcessExists(token) {
  if (process.platform !== 'linux' || !token ||
      !Number.isSafeInteger(token.pid) || token.pid <= 1 ||
      token.pid === process.pid || typeof token.startTime !== 'string' ||
      !/^[0-9]+$/.test(token.startTime)) throw unknown();
  let text;
  try { text = await readFile(`/proc/${token.pid}/stat`, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return false;
    throw unknown();
  }
  const end = text.lastIndexOf(')');
  if (end < 0 || !text.startsWith(`${token.pid} (`)) throw unknown();
  const fields = text.slice(end + 1).trim().split(/\s+/);
  if (fields.length < 20 || !/^[0-9]+$/.test(fields[19])) throw unknown();
  // A reused PID is not the original instance. Never signal its replacement.
  return fields[19] === token.startTime;
}

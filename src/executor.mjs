import { captureOwnedGroup, captureOwnedDescendant, readOwnedProcessSockets, ownedProcessExists } from './proc-sockets.mjs';
import { spawn } from 'node:child_process';
import { loadImageConfig } from './image-config.mjs';
import { unsafeListeningPorts } from './net-check.mjs';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DEADLINES_MS, OUTPUT_LIMIT_BYTES, TERMINATION_GRACE_MS, ToolError, validateArguments } from './contracts.mjs';

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const operationId = () => randomBytes(16).toString('hex');
const within = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

function initialResult(id) {
  return { operationId: id, state: 'queued', exitCode: null, stdout: '', stderr: '', truncated: false, errorCode: null };
}

function safeEnvironment(source) {
  const names = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR',
    'QNX_HOST', 'QNX_TARGET', 'QNX_CONFIGURATION', 'QNX_LICENSE'];
  const result = { LANG: 'C', LC_ALL: 'C' };
  for (const name of names) {
    if (typeof source[name] === 'string') result[name] = source[name];
  }
  return result;
}

async function findExecutable(name, env) {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.com`] : [name];
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    // Ignore relative PATH entries, including the implicit current directory.
    if (!path.isAbsolute(directory)) continue;
    for (const filename of names) {
      try {
        const resolved = await realpath(path.join(directory, filename));
        if (!(await stat(resolved)).isFile()) continue;
        await access(resolved, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return resolved;
      } catch { /* Try the next trusted PATH entry. */ }
    }
  }
  throw new ToolError('TOOL_MISSING', 'The configured compiler executable is unavailable.');
}

function boundedText(buffer) {
  // Avoid emitting a replacement character for a partial final UTF-8 sequence.
  return new TextDecoder('utf-8').decode(buffer, { stream: true });
}

async function fileHash(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export class Executor {
  static async create({ env = process.env, deadlines = {}, graceMs = TERMINATION_GRACE_MS, imageNetworkSnapshot } = {}) {
    const configuredRoot = env.QNX_MCP_WORKSPACE;
    if (typeof configuredRoot !== 'string' || !path.isAbsolute(configuredRoot)) {
      throw new ToolError('UNSAFE_CONFIGURATION', 'QNX_MCP_WORKSPACE must name an existing absolute directory.');
    }
    let root;
    try {
      root = await realpath(configuredRoot);
      if (!(await stat(root)).isDirectory()) throw new Error();
    } catch {
      throw new ToolError('UNSAFE_CONFIGURATION', 'The configured workspace is unavailable.');
    }
    for (const [name, value] of Object.entries(deadlines)) {
      if (!Object.hasOwn(DEADLINES_MS, name) || !Number.isFinite(value) || value <= 0 || value > DEADLINES_MS[name]) {
        throw new ToolError('UNSAFE_CONFIGURATION', 'Invalid internal deadline override.');
      }
    }
    if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs > TERMINATION_GRACE_MS) {
      throw new ToolError('UNSAFE_CONFIGURATION', 'Invalid termination grace period.');
    }
    if (imageNetworkSnapshot !== undefined && typeof imageNetworkSnapshot !== 'function') {
      throw new ToolError('UNSAFE_CONFIGURATION', 'Invalid internal network observer.');
    }
    const imageConfig = await loadImageConfig(env);
    return new Executor(root, safeEnvironment(env), { ...DEADLINES_MS, ...deadlines }, graceMs, imageConfig, imageNetworkSnapshot);
  }

  constructor(root, env, deadlines, graceMs, imageConfig = Object.freeze({ version: 1, enabled: false }), imageNetworkSnapshot) {
    this.imageConfig = imageConfig;
    this.imageNetworkSnapshot = imageNetworkSnapshot;
    this.images = new Map();
    this.root = root;
    this.env = env;
    this.deadlines = deadlines;
    this.graceMs = graceMs;
    this.operations = new Map();
    this.mutatingOperation = null;
    this.compiler = null;
    this.closed = false;
  }

  snapshot(operation) {
    return structuredClone(operation.result);
  }

  getOperation(id) {
    const operation = this.operations.get(id);
    if (!operation) throw new ToolError('UNKNOWN_OPERATION', 'Unknown operation ID.');
    return operation;
  }

  async call(name, supplied) {
    const args = validateArguments(name, supplied);
    if (name === 'qnx_operation_status') return this.snapshot(this.getOperation(args.operationId));
    if (name === 'qnx_operation_cancel') {
      const operation = this.getOperation(args.operationId);
      if (terminal.has(operation.result.state)) {
        return { ...this.snapshot(operation), cancellationAccepted: false };
      }
      this.requestStop(operation, 'CANCELLED');
      return { ...this.snapshot(operation), cancellationAccepted: true };
    }
    if (this.closed) throw new ToolError('UNSAFE_CONFIGURATION', 'The executor is shutting down.');
    if (name.startsWith('qnx_image_')) {
      if (!this.imageConfig.enabled) {
        throw new ToolError('UNSAFE_CONFIGURATION', 'Image operations are disabled by operator configuration.');
      }
      // enabled=true records operator intent; verified host controls are still required.
      // No MCP argument or environment switch can bypass these gates.
      // Persisted mkqnximage configuration, host isolation, ownership, stop
      // scope and loopback listeners have not yet been verified on the host.
      throw new ToolError('UNSAFE_CONFIGURATION', 'Image operations are disabled pending verified configuration, isolation and instance ownership.');
    }
    const mutating = name === 'qnx_compile_c';
    if (this.mutatingOperation !== null ||
        [...this.operations.values()].some(item => !terminal.has(item.result.state))) {
      throw new ToolError('BUSY', 'Another mutating operation is still active.');
    }
    // Bound retained operation history. Never discard a running operation.
    if (this.operations.size >= 128) {
      for (const [id, operation] of this.operations) {
        if (terminal.has(operation.result.state)) {
          this.operations.delete(id);
          break;
        }
      }
      if (this.operations.size >= 128) throw new ToolError('BUSY', 'Operation capacity reached.');
    }
    const id = operationId();
    const operation = {
      result: initialResult(id), child: null, stopReason: null,
      stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
      deadlineTimer: null, escalationTimer: null, done: null, mutating,
    };
    this.operations.set(id, operation);
    if (mutating) this.mutatingOperation = id;
    operation.done = this.run(operation, name, args);
    return this.snapshot(operation);
  }

  checkpoint(operation) {
    if (operation.stopReason) throw new ToolError(operation.stopReason, 'Operation termination requested.');
  }

  capture(operation, stream, chunk) {
    const remaining = OUTPUT_LIMIT_BYTES - operation[stream].length;
    if (chunk.length > remaining) operation.result.truncated = true;
    if (remaining > 0) {
      operation[stream] = Buffer.concat([operation[stream], chunk.subarray(0, remaining)]);
      operation.result[stream] = boundedText(operation[stream]);
    }
  }

  signalOwnedGroup(operation, signal) {
    const child = operation.child;
    if (!child || !Number.isInteger(child.pid)) return true;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  }

  requestStop(operation, reason) {
    if (terminal.has(operation.result.state)) return;
    operation.stopReason ??= reason;
    // Image startup performs verified cleanup before reporting cancellation.
    if (operation.imageInstance) return;
    if (!operation.child) return;
    if (!this.signalOwnedGroup(operation, 'SIGTERM')) {
      throw new ToolError('CANCEL_FAILED', 'Could not signal the owned process group.');
    }
    if (!operation.escalationTimer) {
      operation.escalationTimer = setTimeout(() => {
        // Only the detached process group created for this operation is targeted.
        // Never search for processes by executable name or caller-supplied PID.
        if (!this.signalOwnedGroup(operation, 'SIGKILL')) operation.killFailed = true;
      }, this.graceMs);
    }
  }

  async command(operation, executable, argv, cwd) {
    this.checkpoint(operation);
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(executable, argv, {
          cwd, env: this.env, shell: false, windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        reject(new ToolError('TOOL_MISSING', 'Could not start the configured executable.'));
        return;
      }
      operation.child = child;
      let spawnError = null;
      child.stdout.on('data', chunk => this.capture(operation, 'stdout', chunk));
      child.stderr.on('data', chunk => this.capture(operation, 'stderr', chunk));
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, signal) => {
        clearTimeout(operation.escalationTimer);
        operation.escalationTimer = null;
        operation.child = null;
        operation.result.exitCode = Number.isInteger(code) ? code : null;
        if (spawnError) {
          reject(new ToolError(spawnError.code === 'ENOENT' ? 'TOOL_MISSING' : 'UNSAFE_CONFIGURATION', 'The configured executable could not run.'));
        } else if (operation.stopReason) {
          reject(new ToolError(operation.stopReason, 'Operation terminated.'));
        } else if (code !== 0 || signal) {
          reject(new ToolError('COMMAND_FAILED', 'The tool returned a nonzero status or terminated by signal.'));
        } else resolve();
      });
    });
  }

  // Internal host interface only. The MCP dispatcher never calls this method.
  async imageOperation(action, imageName) {
    const actions = ['build', 'start', 'ip', 'stop'];
    if (!actions.includes(action) || typeof imageName !== 'string' ||
        !/^[a-z0-9-]{1,32}$/.test(imageName)) {
      throw new ToolError('INVALID_INPUT', 'Invalid internal image action or name.');
    }
    if (this.closed || process.platform !== 'linux') {
      throw new ToolError('UNSAFE_CONFIGURATION', 'The image executor is unavailable.');
    }
    if (this.mutatingOperation !== null ||
        [...this.operations.values()].some(item => !terminal.has(item.result.state))) {
      throw new ToolError('BUSY', 'Another operation is still active.');
    }
    if (this.operations.size >= 128) {
      const oldest = this.operations.keys().next().value;
      this.operations.delete(oldest);
    }
    const id = operationId();
    const operation = {
      result: initialResult(id), child: null, stopReason: null,
      stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
      deadlineTimer: null, escalationTimer: null, done: null, mutating: true,
    };
    this.operations.set(id, operation);
    this.mutatingOperation = id;
    operation.done = this.runImage(operation, action, imageName);
    return this.snapshot(operation);
  }

  async imageDirectory(imageName, create) {
    const imagesPath = path.join(this.root, 'images');
    if (create) {
      try { await mkdir(imagesPath, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const images = await this.checkedPath('images');
    if (!(await stat(images)).isDirectory()) {
      throw new ToolError('UNSAFE_CONFIGURATION', 'Images path must be a directory.');
    }
    const candidate = path.join(images, imageName);
    if (create) {
      try { await mkdir(candidate, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const directory = await realpath(candidate);
    if (!within(this.root, directory) || !within(images, directory)) {
      throw new ToolError('OUTSIDE_WORKSPACE', 'Image directory escapes its workspace.');
    }
    const metadata = await lstat(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || directory !== candidate) {
      throw new ToolError('UNSAFE_CONFIGURATION', 'Image directory must be a canonical directory.');
    }
    return directory;
  }

  async launchImageProcess(operation, executable, directory) {
    this.checkpoint(operation);
    const child = spawn(executable, ['--type=qemu', '--arch=x86_64', '--run'], {
      cwd: directory, env: this.env, shell: false, windowsHide: true,
      detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const instance = {
      directory, executable, child, launcher: null, target: null,
      exited: false, closed: false, spawnError: null, exitCode: null,
    };
    // The pipe remains open and private. Never write client input to QEMU.
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => this.capture(operation, 'stdout', chunk));
    child.stderr.on('data', chunk => this.capture(operation, 'stderr', chunk));
    child.on('error', error => { instance.spawnError = error; });
    child.once('exit', code => {
      instance.exited = true;
      instance.exitCode = code;
    });
    instance.done = new Promise(resolve => {
      child.once('close', () => { instance.closed = true; resolve(); });
    });
    operation.child = child;
    operation.imageInstance = instance;
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => reject(new ToolError('COMMAND_FAILED',
        'The image launcher could not start; inspect its bounded log.')));
    });
    instance.launcher = await captureOwnedGroup(child.pid);
    this.checkpoint(operation);
    return instance;
  }

  async awaitImageProcess(operation, instance) {
    const filename = path.join(instance.directory, 'output', 'qemu.pid');
    const expires = Date.now() + this.deadlines.qnx_image_start;
    while (Date.now() < expires) {
      this.checkpoint(operation);
      if (instance.spawnError || instance.exited || instance.closed) {
        operation.result.exitCode = instance.exitCode;
        throw new ToolError('COMMAND_FAILED',
          'The image launcher exited before ownership was verified; inspect its bounded log.');
      }
      if (operation.result.truncated) {
        throw new ToolError('OUTPUT_LIMIT', 'Image launcher output exceeded its limit.');
      }
      let metadata;
      try { metadata = await lstat(filename); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (metadata) {
        if (!metadata.isFile() || metadata.isSymbolicLink() ||
            metadata.size < 1 || metadata.size > 64 ||
            await realpath(filename) !== filename) {
          throw new ToolError('UNSAFE_CONFIGURATION', 'Invalid image PID file.');
        }
        const text = (await readFile(filename, 'utf8')).trim();
        if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text))) {
          throw new ToolError('UNSAFE_CONFIGURATION', 'Invalid image PID.');
        }
        try {
          instance.target = await captureOwnedDescendant(instance.launcher, Number(text));
        } catch {
          throw new ToolError('UNSAFE_CONFIGURATION',
            'The image PID is not a verified descendant of the owned launcher.');
        }
        return instance.target;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new ToolError('TIMEOUT', 'Timed out waiting for the owned image PID file.');
  }

  async checkImageProcessNetwork(operation, instance, imageName) {
    try {
      const observation = this.imageNetworkSnapshot
        ? await this.imageNetworkSnapshot({
          imageName, directory: instance.directory,
          launcher: instance.launcher, target: instance.target,
        })
        : await readOwnedProcessSockets(instance.launcher, instance.target);
      this.checkpoint(operation);
      const ports = unsafeListeningPorts(
        observation.tcpText, observation.tcp6Text, observation.ownedInodes);
      if (ports.length) {
        throw new ToolError('UNSAFE_NETWORK', 'The owned image has a non-loopback listener.');
      }
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError('UNSAFE_NETWORK', 'Image network safety could not be established.');
    }
  }

  async stopOwnedImage(instance) {
    if (!instance?.launcher || !instance.target) {
      throw new ToolError('CANCEL_FAILED', 'Image ownership has not been verified.');
    }
    const pause = () => new Promise(resolve => setTimeout(resolve, 20));
    const targetExists = () => ownedProcessExists(instance.target);
    const groupSignal = async signal => {
      // Recheck the original group leader before every signal; never target
      // a replacement process that happens to reuse its numeric PID.
      const current = await captureOwnedGroup(instance.launcher.pid);
      if (current.startTime !== instance.launcher.startTime ||
          current.group !== instance.launcher.group ||
          current.session !== instance.launcher.session) {
        throw new ToolError('CANCEL_FAILED', 'Owned launcher identity changed.');
      }
      try { process.kill(-instance.launcher.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const removed = async () => !(await targetExists()) && instance.closed;
    const waitRemoved = async milliseconds => {
      const expires = Date.now() + milliseconds;
      do {
        if (await removed()) return true;
        await pause();
      } while (Date.now() < expires);
      return removed();
    };
    const cleanup = {
      result: initialResult(operationId()), child: null, stopReason: null,
      stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), escalationTimer: null,
    };
    let commandFailed = false;
    let forced = false;
    try {
      if (await targetExists()) {
        const current = await captureOwnedDescendant(
          instance.launcher, instance.target.pid);
        if (current.startTime !== instance.target.startTime) {
          throw new ToolError('CANCEL_FAILED', 'Owned image identity changed.');
        }
        const timer = setTimeout(() => {
          try { this.requestStop(cleanup, 'TIMEOUT'); }
          catch { cleanup.killFailed = true; }
        }, Math.min(this.deadlines.qnx_image_stop, 5000));
        try {
          await this.command(cleanup, instance.executable,
            ['--type=qemu', '--arch=x86_64', '--stop'], instance.directory);
          commandFailed = cleanup.result.truncated || Boolean(cleanup.killFailed);
        } catch {
          commandFailed = true;
        } finally {
          clearTimeout(timer);
          clearTimeout(cleanup.escalationTimer);
        }
        // Target disappearance may precede the launcher's close event.
        // Await both confirmations before attempting identity-checked escalation.
        await waitRemoved(5000);
      }
      if (!(await removed())) {
        forced = true;
        // A vanished launcher cannot authorize signalling a reused group ID.
        await groupSignal('SIGTERM');
        if (!(await waitRemoved(Math.max(50, this.graceMs)))) {
          await groupSignal('SIGKILL');
          if (!(await waitRemoved(1000))) {
            throw new ToolError('CANCEL_FAILED', 'Owned image removal was not confirmed.');
          }
        }
      }
      return { forced, commandFailed, stdout: cleanup.result.stdout,
        stderr: cleanup.result.stderr, truncated: cleanup.result.truncated };
    } catch {
      throw new ToolError('CANCEL_FAILED', 'Owned image cleanup could not be confirmed.');
    }
  }

  async stopImageForCleanup(executable, directory) {
    // Cleanup has its own bounded lifetime, independent of cancellation of start.
    const cleanup = {
      result: initialResult(operationId()), child: null, stopReason: null,
      stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), escalationTimer: null,
    };
    const timer = setTimeout(() => {
      try { this.requestStop(cleanup, 'TIMEOUT'); }
      catch { cleanup.killFailed = true; }
    }, this.deadlines.qnx_image_stop);
    try {
      await this.command(cleanup, executable,
        ['--type=qemu', '--arch=x86_64', '--stop'], directory);
      if (cleanup.result.truncated || cleanup.killFailed) throw new Error();
    } catch {
      throw new ToolError('CANCEL_FAILED', 'Image cleanup could not be confirmed.');
    } finally {
      clearTimeout(timer);
      clearTimeout(cleanup.escalationTimer);
    }
  }

  async cleanupImageInstance(instance) {
    if (instance?.target) return this.stopOwnedImage(instance);
    if (!instance?.child?.pid) {
      throw new ToolError('CANCEL_FAILED', 'Image launcher ownership is unavailable.');
    }
    // Without a verified guest PID, only the captured launcher group may be
    // targeted. Never invoke --stop against an unverified PID file.
    const absent = () => {
      try { process.kill(-instance.child.pid, 0); return false; }
      catch (error) {
        if (error.code === 'ESRCH') return true;
        throw error;
      }
    };
    const waitAbsent = async milliseconds => {
      const expires = Date.now() + milliseconds;
      do {
        if (instance.closed && absent()) return true;
        await new Promise(resolve => setTimeout(resolve, 20));
      } while (Date.now() < expires);
      return instance.closed && absent();
    };
    const signal = async value => {
      if (!instance.launcher) {
        throw new ToolError('CANCEL_FAILED', 'Launcher identity was not captured.');
      }
      const current = await captureOwnedGroup(instance.launcher.pid);
      if (current.startTime !== instance.launcher.startTime ||
          current.group !== instance.launcher.group ||
          current.session !== instance.launcher.session) {
        throw new ToolError('CANCEL_FAILED', 'Launcher identity changed.');
      }
      try { process.kill(-current.pid, value); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    try {
      if (instance.closed && absent()) return;
      await signal('SIGTERM');
      if (await waitAbsent(Math.max(50, this.graceMs))) return;
      await signal('SIGKILL');
      if (await waitAbsent(1000)) return;
    } catch {
      throw new ToolError('CANCEL_FAILED', 'Launcher group cleanup could not be confirmed.');
    }
    throw new ToolError('CANCEL_FAILED', 'Launcher group removal was not confirmed.');
  }

  async runImage(operation, action, imageName) {
    operation.result.state = 'running';
    let owned;
    let startAttempted = false;
    operation.deadlineTimer = setTimeout(() => {
      try { this.requestStop(operation, 'TIMEOUT'); }
      catch { operation.killFailed = true; }
    }, this.deadlines['qnx_image_' + action]);
    try {
      const directory = await this.imageDirectory(imageName, action === 'build');
      this.checkpoint(operation);
      owned = this.images.get(imageName);
      if (action !== 'build' && (!owned || owned.directory !== directory)) {
        throw new ToolError('UNSAFE_CONFIGURATION', 'Image was not built by this executor.');
      }
      if ((action === 'build' || action === 'start') && owned?.running) {
        throw new ToolError('BUSY', 'Stop the owned image before rebuilding or restarting it.');
      }
      if ((action === 'ip' || action === 'stop') &&
          (!owned.running || !owned.instance?.target)) {
        throw new ToolError('UNSAFE_CONFIGURATION', 'The image has no verified running instance.');
      }
      const executable = await findExecutable('mkqnximage', this.env);
      this.checkpoint(operation);
      if (action === 'start') {
        startAttempted = true;
        const instance = await this.launchImageProcess(operation, executable, directory);
        owned.instance = instance;
        owned.running = true;
        await this.awaitImageProcess(operation, instance);
        await captureOwnedDescendant(instance.launcher, instance.target.pid);
        await this.checkImageProcessNetwork(operation, instance, imageName);
        const verified = await captureOwnedDescendant(instance.launcher, instance.target.pid);
        if (verified.startTime !== instance.target.startTime) {
          throw new ToolError('UNSAFE_CONFIGURATION', 'Owned image identity changed.');
        }
      } else if (action === 'stop') {
        const result = await this.stopOwnedImage(owned.instance);
        owned.running = false;
        owned.instance = null;
        operation.result.cleanupForced = result.forced;
        operation.result.stopCommandFailed = result.commandFailed;
        this.capture(operation, 'stdout', Buffer.from(result.stdout));
        this.capture(operation, 'stderr', Buffer.from(result.stderr));
        operation.result.truncated ||= result.truncated;
      } else {
        if (action === 'ip') {
          const current = await captureOwnedDescendant(
            owned.instance.launcher, owned.instance.target.pid);
          if (current.startTime !== owned.instance.target.startTime) {
            throw new ToolError('UNSAFE_CONFIGURATION', 'Owned image identity changed.');
          }
        }
        await this.command(operation, executable,
          ['--type=qemu', '--arch=x86_64', action === 'build' ? '--build' : '--getip'],
          directory);
        this.checkpoint(operation);
        if (operation.result.truncated) {
          throw new ToolError('OUTPUT_LIMIT', 'Image command output exceeded its limit.');
        }
        if (action === 'build') {
          this.images.set(imageName, { directory, running: false, instance: null });
        } else {
          const current = await captureOwnedDescendant(
            owned.instance.launcher, owned.instance.target.pid);
          if (current.startTime !== owned.instance.target.startTime) {
            throw new ToolError('UNSAFE_CONFIGURATION', 'Owned image identity changed.');
          }
        }
      }
      this.checkpoint(operation);
      if (operation.result.truncated) {
        throw new ToolError('OUTPUT_LIMIT', 'Image operation output exceeded its limit.');
      }
      operation.result.state = 'succeeded';
    } catch (error) {
      let cleanupFailed = false;
      const instance = operation.imageInstance;
      if (startAttempted && instance) {
        clearTimeout(operation.deadlineTimer);
        clearTimeout(operation.escalationTimer);
        if (owned) { owned.instance = instance; owned.running = true; }
        try {
          await this.cleanupImageInstance(instance);
          if (owned) { owned.running = false; owned.instance = null; }
        } catch { cleanupFailed = true; }
      }
      const code = cleanupFailed || operation.killFailed ? 'CANCEL_FAILED'
        : operation.stopReason ?? (error instanceof ToolError ? error.code : 'COMMAND_FAILED');
      operation.result.errorCode = code;
      operation.result.state = code === 'TIMEOUT' ? 'timed_out'
        : code === 'CANCELLED' ? 'cancelled' : 'failed';
      operation.result.message = cleanupFailed ? 'Image cleanup could not be confirmed.'
        : error instanceof ToolError ? error.message : 'The image operation could not complete.';
    } finally {
      clearTimeout(operation.deadlineTimer);
      clearTimeout(operation.escalationTimer);
      operation.child = null;
      if (this.mutatingOperation === operation.result.operationId) this.mutatingOperation = null;
    }
  }

  async checkedPath(relative) {
    let resolved;
    try { resolved = await realpath(path.join(this.root, relative)); }
    catch { throw new ToolError('INVALID_INPUT', 'A required workspace path is unavailable.'); }
    if (!within(this.root, resolved)) throw new ToolError('OUTSIDE_WORKSPACE', 'The path resolves outside the workspace.');
    return resolved;
  }

  async outputDirectory(operation) {
    const buildPath = path.join(this.root, 'build');
    try { await mkdir(buildPath); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const build = await this.checkedPath('build');
    if (!(await stat(build)).isDirectory()) throw new ToolError('UNSAFE_CONFIGURATION', 'Build path must be a directory.');
    this.checkpoint(operation);
    const directory = path.join(build, operation.result.operationId);
    await mkdir(directory, { mode: 0o700 });
    const canonical = await realpath(directory);
    if (!within(this.root, canonical)) throw new ToolError('OUTSIDE_WORKSPACE', 'Output directory escapes the workspace.');
    return canonical;
  }

  async run(operation, name, args) {
    operation.result.state = 'running';
    operation.deadlineTimer = setTimeout(() => {
      try { this.requestStop(operation, 'TIMEOUT'); }
      catch { operation.killFailed = true; }
    }, this.deadlines[name]);
    try {
      // Windows process-tree ownership and reliable termination need a verified
      // Job Object implementation. Do not claim child.kill covers descendants.
      if (process.platform === 'win32') {
        throw new ToolError('UNSAFE_CONFIGURATION', 'Process execution requires verified process-tree isolation; native Windows is not enabled. Use the intended Linux/WSL host.');
      }
      this.compiler ??= findExecutable('qcc', this.env);
      const executable = await this.compiler;
      this.checkpoint(operation);
      if (name === 'qnx_toolchain_info') {
        await this.command(operation, executable, ['--version'], this.root);
        await this.command(operation, executable, ['-V'], this.root);
      } else {
        const source = await this.checkedPath(args.source);
        if (!(await stat(source)).isFile()) throw new ToolError('INVALID_INPUT', 'Source must be a regular file.');
        const directory = await this.outputDirectory(operation);
        this.checkpoint(operation);
        const output = path.join(directory, 'program');
        await this.command(operation, executable, ['-Vgcc_ntox86_64', '-o', output, source], this.root);
        this.checkpoint(operation);
        const outputInfo = await lstat(output);
        if (!outputInfo.isFile() || outputInfo.isSymbolicLink()) {
          throw new ToolError('UNSAFE_CONFIGURATION', 'Compiler output must be a regular file.');
        }
        const canonicalOutput = await realpath(output);
        if (!within(this.root, canonicalOutput) || canonicalOutput !== output) {
          throw new ToolError('OUTSIDE_WORKSPACE', 'Compiler output escaped its assigned path.');
        }
        const sha256 = await fileHash(canonicalOutput);
        this.checkpoint(operation);
        operation.result.artifact = {
          path: path.relative(this.root, canonicalOutput).split(path.sep).join('/'),
          size: outputInfo.size, sha256,
        };
      }
      this.checkpoint(operation);
      operation.result.state = operation.result.truncated ? 'failed' : 'succeeded';
      operation.result.errorCode = operation.result.truncated ? 'OUTPUT_LIMIT' : null;
    } catch (error) {
      const code = operation.killFailed ? 'CANCEL_FAILED' : operation.stopReason ?? (error instanceof ToolError ? error.code : 'COMMAND_FAILED');
      operation.result.errorCode = code;
      operation.result.state = code === 'TIMEOUT' ? 'timed_out' : code === 'CANCELLED' ? 'cancelled' : 'failed';
      // Do not include raw exceptions: they can contain host paths or environment.
      operation.result.message = error instanceof ToolError ? error.message : 'The operation could not complete.';
    } finally {
      clearTimeout(operation.deadlineTimer);
      clearTimeout(operation.escalationTimer);
      if (operation.mutating && this.mutatingOperation === operation.result.operationId) {
        this.mutatingOperation = null;
      }
    }
  }

  async close() {
    this.closed = true;
    const pending = [];
    for (const operation of this.operations.values()) {
      if (!terminal.has(operation.result.state)) {
        try { this.requestStop(operation, 'CANCELLED'); }
        catch { operation.killFailed = true; }
        pending.push(operation.done);
      }
    }
    await Promise.allSettled(pending);
    let cleanupFailed = false;
    for (const owned of this.images.values()) {
      if (!owned.instance) continue;
      try {
        await this.cleanupImageInstance(owned.instance);
        owned.running = false;
        owned.instance = null;
      } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) {
      throw new ToolError('CANCEL_FAILED', 'Executor shutdown could not confirm image cleanup.');
    }
  }
}

import { captureOwnedGroup, captureOwnedDescendant, readOwnedProcessSockets, ownedProcessExists } from './proc-sockets.mjs';
import { spawn } from 'node:child_process';
import { loadImageConfig } from './image-config.mjs';
import { loadRunConfig } from './run-config.mjs';
import { open } from 'node:fs/promises';
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
    const runConfig = await loadRunConfig(env);
    const executor = new Executor(root, safeEnvironment(env), { ...DEADLINES_MS, ...deadlines }, graceMs, imageConfig, imageNetworkSnapshot);
    executor.runConfig = runConfig;
    return executor;
  }

  constructor(root, env, deadlines, graceMs, imageConfig = Object.freeze({ version: 1, enabled: false }), imageNetworkSnapshot) {
    this.imageConfig = imageConfig;
    this.runConfig = Object.freeze({ version: 1, enabled: false });
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
    if (name === 'qnx_run_artifact' && !this.runConfig.enabled) {
      throw new ToolError('UNSAFE_CONFIGURATION', 'Artifact execution is disabled by operator configuration.');
    }
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
    const runCompilation = name === 'qnx_run_artifact' ? this.getRunCompilation(args.compileOperationId) : null;
    const mutating = name === 'qnx_compile_c' || name === 'qnx_run_artifact';
    if (this.mutatingOperation !== null ||
        [...this.operations.values()].some(item => !terminal.has(item.result.state))) {
      throw new ToolError('BUSY', 'Another mutating operation is still active.');
    }
    // Bound retained operation history. Never discard a running operation.
    if (this.operations.size >= 128) {
      for (const [id, operation] of this.operations) {
        if (operation !== runCompilation && terminal.has(operation.result.state)) {
          this.operations.delete(id);
          break;
        }
      }
      if (this.operations.size >= 128) throw new ToolError('BUSY', 'Operation capacity reached.');
    }
    const id = operationId();
    const operation = {
      name, artifactRecord: null, runCompilation,
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
        : await this.observeOwnedProcessSockets(instance);
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

  // A descriptor closed while /proc is being read makes one observation
  // inconsistent; observe again a bounded number of times and still fail
  // closed, never accepting a partial socket set.
  async observeOwnedProcessSockets(instance) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await readOwnedProcessSockets(instance.launcher, instance.target);
      } catch (error) {
        if (attempt >= 5) throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
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

  getRunCompilation(compileOperationId) {
    const compilation = this.getOperation(compileOperationId);
    if (compilation.name !== 'qnx_compile_c' ||
        compilation.result.state !== 'succeeded' || !compilation.artifactRecord) {
      throw new ToolError('INVALID_INPUT', 'A successful compilation from this server is required.');
    }
    return compilation;
  }

  async copyRegisteredRunArtifact(operation, compilation, directory) {
    const record = compilation.artifactRecord;
    const expected = path.join(this.root, 'build', compilation.result.operationId, 'program');
    if (!record || record.filename !== expected || record.architecture !== 'x86_64') {
      throw new ToolError('UNSAFE_CONFIGURATION', 'The registered artifact is unavailable.');
    }
    let source;
    let destination;
    const unchanged = metadata => metadata.isFile() &&
      metadata.dev === record.dev && metadata.ino === record.ino &&
      metadata.size === record.size && metadata.mtimeMs === record.mtimeMs &&
      metadata.ctimeMs === record.ctimeMs;
    try {
      this.checkpoint(operation);
      let current = this.root;
      for (const component of ['build', compilation.result.operationId]) {
        current = path.join(current, component);
        const metadata = await lstat(current);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
            await realpath(current) !== current) {
          throw new ToolError('UNSAFE_CONFIGURATION', 'Artifact directories must be controlled directories.');
        }
      }
      const metadata = await lstat(expected);
      if (metadata.isSymbolicLink() || !unchanged(metadata) ||
          await realpath(expected) !== expected) {
        throw new ToolError('UNSAFE_CONFIGURATION', 'The registered artifact was replaced or modified.');
      }
      source = await open(expected, constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      if (!unchanged(await source.stat())) {
        throw new ToolError('UNSAFE_CONFIGURATION', 'The registered artifact changed before copying.');
      }
      const target = path.join(directory, 'automata-artifact');
      destination = await open(target, constants.O_WRONLY | constants.O_CREAT |
        constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o700);
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(65536);
      let copied = 0;
      while (true) {
        this.checkpoint(operation);
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        copied += bytesRead;
        if (copied > record.size) {
          throw new ToolError('UNSAFE_CONFIGURATION', 'The artifact grew during copying.');
        }
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          this.checkpoint(operation);
          const result = await destination.write(buffer, written, bytesRead - written, null);
          if (result.bytesWritten <= 0) throw new Error('Incomplete artifact write.');
          written += result.bytesWritten;
        }
      }
      if (copied !== record.size || hash.digest('hex') !== record.sha256 ||
          !unchanged(await source.stat())) {
        throw new ToolError('UNSAFE_CONFIGURATION', 'Artifact integrity verification failed.');
      }
      await destination.sync();
      if (await fileHash(target) !== record.sha256) {
        throw new ToolError('UNSAFE_CONFIGURATION', 'Copied artifact integrity verification failed.');
      }
      this.checkpoint(operation);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError('UNSAFE_CONFIGURATION', 'The registered artifact could not be copied safely.');
    } finally {
      const closed = await Promise.allSettled([source?.close(), destination?.close()]);
      if (closed.some(result => result.status === 'rejected')) {
        throw new ToolError('UNSAFE_CONFIGURATION', 'Artifact descriptors could not be closed.');
      }
    }
  }

  async copyRunTemplate(operation, source, destination, topLevel = true) {
    this.checkpoint(operation);
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      this.checkpoint(operation);
      if (topLevel && entry.name === 'output') continue;
      const input = path.join(source, entry.name);
      const output = path.join(destination, entry.name);
      const before = await lstat(input);
      if (before.isSymbolicLink() || await realpath(input) !== input) {
        throw new ToolError('UNSAFE_CONFIGURATION', 'Template links are forbidden.');
      }
      if (before.isDirectory()) {
        await mkdir(output, { mode: 0o700 });
        await this.copyRunTemplate(operation, input, output, false);
        continue;
      }
      if (!before.isFile()) {
        throw new ToolError('UNSAFE_CONFIGURATION', 'Template entries must be regular files or directories.');
      }
      let reader;
      let writer;
      try {
        reader = await open(input, constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        const unchanged = value => value.isFile() &&
          value.dev === before.dev && value.ino === before.ino &&
          value.size === before.size && value.mtimeMs === before.mtimeMs &&
          value.ctimeMs === before.ctimeMs;
        if (!unchanged(await reader.stat())) {
          throw new ToolError('UNSAFE_CONFIGURATION', 'Template changed before copying.');
        }
        writer = await open(output, constants.O_WRONLY | constants.O_CREAT |
          constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          (before.mode & 0o111) | 0o600);
        const buffer = Buffer.alloc(65536);
        let copied = 0;
        while (true) {
          this.checkpoint(operation);
          const { bytesRead } = await reader.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          copied += bytesRead;
          if (copied > before.size) {
            throw new ToolError('UNSAFE_CONFIGURATION', 'Template file grew during copying.');
          }
          let offset = 0;
          while (offset < bytesRead) {
            this.checkpoint(operation);
            const { bytesWritten } = await writer.write(buffer, offset, bytesRead - offset, null);
            if (bytesWritten <= 0) throw new Error('Incomplete template copy.');
            offset += bytesWritten;
          }
        }
        if (copied !== before.size || !unchanged(await reader.stat())) {
          throw new ToolError('UNSAFE_CONFIGURATION', 'Template changed during copying.');
        }
      } finally {
        const closed = await Promise.allSettled([reader?.close(), writer?.close()]);
        if (closed.some(item => item.status === 'rejected')) {
          throw new ToolError('UNSAFE_CONFIGURATION', 'Template descriptors could not be closed.');
        }
      }
    }
  }

  async prepareRunDirectory(operation, compilation) {
    if (!this.runConfig.enabled) {
      throw new ToolError('UNSAFE_CONFIGURATION', 'Artifact execution is disabled by operator configuration.');
    }
    this.checkpoint(operation);
    const { writeFile } = await import('node:fs/promises');
    const template = this.runConfig.templateDir;
    const runs = path.join(this.root, 'runs');
    // The generated IFS snippet contains an unquoted host filename.
    // Restrict its alphabet rather than allowing buildfile metacharacters.
    if (!/^[A-Za-z0-9_./-]+$/.test(runs)) {
      throw new ToolError('UNSAFE_CONFIGURATION', 'Run directory requires a buildfile-safe absolute path.');
    }
    if (within(template, runs) || within(runs, template)) {
      throw new ToolError('UNSAFE_CONFIGURATION', 'Template and run directories must not overlap.');
    }
    const templateInfo = await lstat(template);
    if (!templateInfo.isDirectory() || templateInfo.isSymbolicLink() ||
        await realpath(template) !== template) {
      throw new ToolError('UNSAFE_CONFIGURATION', 'Template must be a canonical directory without links.');
    }
    this.checkpoint(operation);
    try { await mkdir(runs, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const runsInfo = await lstat(runs);
    if (!runsInfo.isDirectory() || runsInfo.isSymbolicLink() ||
        await realpath(runs) !== runs) {
      throw new ToolError('UNSAFE_CONFIGURATION', 'Runs must be a controlled workspace directory.');
    }
    const directory = path.join(runs, operation.result.operationId);
    this.checkpoint(operation);
    await mkdir(directory, { mode: 0o700 });
    // Record immediately so the run lifecycle can clean up partial preparation.
    operation.runDirectory = directory;
    const owned = await lstat(directory);
    operation.runDirectoryIdentity = Object.freeze({ dev: owned.dev, ino: owned.ino });
    if (await realpath(directory) !== directory) {
      throw new ToolError('UNSAFE_CONFIGURATION', 'Run directory escaped its assigned path.');
    }
    await this.copyRunTemplate(operation, template, directory);
    await this.copyRegisteredRunArtifact(operation, compilation, directory);
    const snippets = path.join(directory, 'local', 'snippets');
    await mkdir(snippets, { recursive: true, mode: 0o700 });
    const nonce = randomBytes(16).toString('hex');
    operation.runNonce = nonce;
    this.checkpoint(operation);
    await writeFile(path.join(snippets, 'ifs_files.custom'),
      `[perms=0755] automata-artifact=${directory}/automata-artifact
`,
      { mode: 0o600 });
    await writeFile(path.join(snippets, 'post_start.custom'),
      `echo "QNX_RUN_${nonce}_BEGIN"
/proc/boot/automata-artifact
echo "QNX_RUN_${nonce}_EXIT=$?"
`,
      { mode: 0o600 });
    this.checkpoint(operation);
    return directory;
  }

  consumeRunConsole(operation, chunk, final = false) {
    const parser = operation.runConsoleParser ??= {
      retained: Buffer.alloc(0), pending: Buffer.alloc(0),
      bytes: 0, began: false, exited: false, exitCode: null,
    };
    const fail = message => {
      throw new ToolError('COMMAND_FAILED', message);
    };
    parser.bytes += chunk.length;
    operation.result.consoleBytesObserved = parser.bytes;
    const remaining = OUTPUT_LIMIT_BYTES - parser.retained.length;
    if (chunk.length > remaining) operation.result.consoleTruncated = true;
    if (remaining > 0 && chunk.length) {
      parser.retained = Buffer.concat([parser.retained, chunk.subarray(0, remaining)]);
    }
    operation.result.console = boundedText(parser.retained);
    if (parser.bytes > 8 * 1024 * 1024) {
      fail('Guest console exceeded the monitored 8 MiB limit.');
    }
    const prefix = `QNX_RUN_${operation.runNonce}_`;
    const line = bytes => {
      if (bytes.length && bytes[bytes.length - 1] === 13) {
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      const text = bytes.toString('utf8');
      if (text === `${prefix}BEGIN`) {
        if (parser.began || parser.exited) fail('Duplicate or misplaced guest BEGIN marker.');
        parser.began = true;
        return;
      }
      if (!text.startsWith(prefix)) return;
      const value = text.slice(prefix.length);
      if (!/^EXIT=(0|[1-9][0-9]{0,2})$/.test(value)) {
        fail('Malformed guest execution marker.');
      }
      const code = Number(value.slice(5));
      if (!parser.began || parser.exited || code > 255) {
        fail('Duplicate, misplaced or invalid guest EXIT marker.');
      }
      parser.exited = true;
      parser.exitCode = code;
    };
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (parser.pending.length + segment.length > 4096) {
        fail('Guest console line exceeded the parser limit.');
      }
      parser.pending = Buffer.concat([parser.pending, segment]);
      if (newline === -1) break;
      line(parser.pending);
      parser.pending = Buffer.alloc(0);
      offset = newline + 1;
    }
    if (final && parser.pending.length) {
      // A marker requires a complete line; a partial final marker is not proof
      // that the guest program completed. Ordinary partial output is retained.
      if (parser.pending.toString('utf8').startsWith(prefix)) {
        fail('Guest execution marker was not terminated by a newline.');
      }
      parser.pending = Buffer.alloc(0);
    }
    return { completed: parser.exited, exitCode: parser.exitCode };
  }

  async verifyRunDirectory(operation) {
    const expected = path.join(this.root, 'runs', operation.result.operationId);
    const identity = operation.runDirectoryIdentity;
    if (operation.runDirectory !== expected || !identity ||
        !/^[a-f0-9]{32}$/.test(operation.result.operationId)) {
      throw new ToolError('UNSAFE_CONFIGURATION', 'Run directory ownership is unavailable.');
    }
    const runs = path.dirname(expected);
    const parent = await lstat(runs);
    if (!parent.isDirectory() || parent.isSymbolicLink() ||
        await realpath(runs) !== runs) {
      throw new ToolError('UNSAFE_CONFIGURATION', 'Run parent directory changed.');
    }
    const metadata = await lstat(expected);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        metadata.dev !== identity.dev || metadata.ino !== identity.ino ||
        await realpath(expected) !== expected) {
      throw new ToolError('UNSAFE_CONFIGURATION', 'Run directory identity changed.');
    }
    return expected;
  }

  async validateRunImageOutputs(operation) {
    this.checkpoint(operation);
    const directory = await this.verifyRunDirectory(operation);
    const output = path.join(directory, 'output');
    const metadata = await lstat(output);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        await realpath(output) !== output) {
      throw new ToolError('UNSAFE_CONFIGURATION', 'Image output must be a private regular directory.');
    }
    for (const name of ['disk-qemu.vmdk', 'ifs.bin']) {
      this.checkpoint(operation);
      const filename = path.join(output, name);
      let handle;
      try {
        const before = await lstat(filename);
        if (!before.isFile() || before.isSymbolicLink() ||
            before.size === 0 || before.nlink !== 1 ||
            await realpath(filename) !== filename) {
          throw new ToolError('UNSAFE_CONFIGURATION', 'Image output must be a nonempty private regular file.');
        }
        handle = await open(filename, constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== before.dev ||
            opened.ino !== before.ino || opened.size !== before.size ||
            opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs ||
            opened.nlink !== 1) {
          throw new ToolError('UNSAFE_CONFIGURATION', 'Image output changed during validation.');
        }
      } finally {
        if (handle) await handle.close();
      }
    }
    this.checkpoint(operation);
  }

  async removeOwnedRunDirectory(operation) {
    if (!operation.runDirectory) return;
    // The lifecycle sets this only after verifying termination of every
    // process group it created, including the image builder.
    if (operation.runProcessesConfirmedGone !== true) {
      throw new ToolError('CANCEL_FAILED', 'Process cleanup must be confirmed before removing run files.');
    }
    try {
      const directory = await this.verifyRunDirectory(operation);
      const { rm } = await import('node:fs/promises');
      await rm(directory, { recursive: true, force: false });
      try {
        await lstat(directory);
      } catch (error) {
        if (error.code === 'ENOENT') {
          operation.runDirectory = null;
          operation.runDirectoryIdentity = null;
          return;
        }
        throw error;
      }
      throw new Error('Run directory remains present.');
    } catch {
      throw new ToolError('CANCEL_FAILED', 'Private run directory cleanup could not be confirmed.');
    }
  }

  runQemuArguments() {
    return [
      '-smp', '2', '-cpu', 'max', '-m', '1G',
      '-drive', 'file=output/disk-qemu.vmdk,if=ide,id=drv0',
      '-kernel', 'output/ifs.bin',
      '-display', 'none', '-monitor', 'none', '-nic', 'none',
      '-serial', 'file:output/qemu.out', '-pidfile', 'output/qemu.pid',
      '-object', 'rng-random,filename=/dev/urandom,id=rng0',
      '-device', 'virtio-rng-pci,rng=rng0',
    ];
  }

  async launchRunProcess(operation, executable, argv, phase) {
    this.checkpoint(operation);
    if (process.platform !== 'linux' ||
        !['build', 'guest'].includes(phase)) {
      throw new ToolError('UNSAFE_CONFIGURATION', 'Run execution requires Linux process ownership.');
    }
    const directory = await this.verifyRunDirectory(operation);
    this.checkpoint(operation);
    const instance = {
      phase, child: null, launcher: null,
      spawned: false, exited: false, closed: false,
      exitCode: null, signal: null, spawnError: null,
    };
    operation.runProcesses ??= [];
    operation.runProcesses.push(instance);
    operation.runProcessesConfirmedGone = false;
    let child;
    try {
      child = spawn(executable, argv, {
        cwd: directory, env: this.env, shell: false,
        windowsHide: true, detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      instance.closed = true;
      throw new ToolError('TOOL_MISSING', 'The configured run executable could not start.');
    }
    instance.child = child;
    child.stdout.on('data', chunk => this.capture(operation, 'stdout', chunk));
    child.stderr.on('data', chunk => this.capture(operation, 'stderr', chunk));
    child.on('error', error => { instance.spawnError = error; });
    child.once('exit', (code, signal) => {
      instance.exited = true;
      instance.exitCode = Number.isInteger(code) ? code : null;
      instance.signal = signal;
      if (phase === 'build') operation.result.buildExitCode = instance.exitCode;
      else operation.result.qemuExitCode = instance.exitCode;
    });
    instance.done = new Promise(resolve => {
      child.once('close', () => {
        instance.closed = true;
        resolve();
      });
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', () => { instance.spawned = true; resolve(); });
      child.once('error', error => reject(new ToolError(
        error.code === 'ENOENT' ? 'TOOL_MISSING' : 'UNSAFE_CONFIGURATION',
        'The configured run executable could not start.')));
    });
    // Register ownership immediately. Never use the guest pidfile as authority,
    // and do not expose this child to generic cancellation by numeric PID.
    try {
      instance.launcher = await captureOwnedGroup(child.pid);
    } catch {
      operation.runCleanupBlocked = true;
      throw new ToolError('CANCEL_FAILED', 'Run process ownership could not be established.');
    }
    this.checkpoint(operation);
    return instance;
  }

  async cleanupRunProcesses(operation, expires = performance.now() + 30000) {
    const { readdir } = await import('node:fs/promises');
    const pause = () => new Promise(resolve => setTimeout(resolve, 20));
    const checkDeadline = () => {
      if (performance.now() >= expires) {
        throw new ToolError('CANCEL_FAILED', 'Run process cleanup deadline expired.');
      }
    };
    const identity = async pid => {
      checkDeadline();
      let text;
      try { text = await readFile(`/proc/${pid}/stat`, 'utf8'); }
      catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
        throw error;
      }
      const end = text.lastIndexOf(')');
      const fields = text.slice(end + 1).trim().split(/\s+/);
      if (end < 0 || !text.startsWith(`${pid} (`) || fields.length < 20 ||
          !/^[0-9]+$/.test(fields[19])) throw new Error('Invalid process identity.');
      const group = Number(fields[2]);
      const session = Number(fields[3]);
      if (!Number.isSafeInteger(group) || !Number.isSafeInteger(session)) {
        throw new Error('Invalid process group.');
      }
      return { pid, group, session, startTime: fields[19], state: fields[0] };
    };
    const same = (left, right) => left && right &&
      left.pid === right.pid && left.group === right.group &&
      left.session === right.session && left.startTime === right.startTime;
    const live = token => token && !['Z', 'X', 'x'].includes(token.state);
    const members = async launcher => {
      checkDeadline();
      const leader = await identity(launcher.pid);
      if (leader && !same(leader, launcher)) throw new Error('Process identity changed.');
      const entries = await readdir('/proc');
      if (entries.length > 32768) throw new Error('Process observation limit exceeded.');
      const found = [];
      for (const entry of entries) {
        checkDeadline();
        if (!/^[1-9][0-9]*$/.test(entry)) continue;
        const pid = Number(entry);
        if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
        const token = await identity(pid);
        if (!token || (token.group !== launcher.group && token.session !== launcher.session)) continue;
        // An owned process that escaped its original group requires operator
        // intervention; never broaden signalling to another process group.
        if (token.group !== launcher.group || token.session !== launcher.session ||
            BigInt(token.startTime) < BigInt(launcher.startTime)) {
          throw new Error('Process ownership could not be confirmed.');
        }
        if (live(token)) found.push(token);
        if (found.length > 1024) throw new Error('Owned process observation limit exceeded.');
      }
      return found;
    };
    const signalMembers = async (tokens, signal) => {
      for (const token of tokens) {
        const current = await identity(token.pid);
        if (!current) continue;
        if (!same(current, token)) throw new Error('Process identity changed before signalling.');
        if (!live(current)) continue;
        try { process.kill(token.pid, signal); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    };
    operation.runProcessesConfirmedGone = false;
    try {
      for (const instance of operation.runProcesses ?? []) {
        if (!instance.spawned) {
          if (!instance.closed || instance.child?.pid) {
            throw new Error('Process launch outcome is uncertain.');
          }
          continue;
        }
        const launcher = instance.launcher;
        if (!launcher || launcher.pid !== launcher.group ||
            launcher.pid !== launcher.session || launcher.pid <= 1 ||
            launcher.pid === process.pid) {
          throw new Error('Run process ownership is unavailable.');
        }
        const forceAt = performance.now() + this.graceMs;
        let termSent = false;
        while (true) {
          checkDeadline();
          const remaining = await members(launcher);
          if (remaining.length === 0 && instance.closed) break;
          if (!termSent || performance.now() >= forceAt) {
            await signalMembers(remaining, termSent ? 'SIGKILL' : 'SIGTERM');
            termSent = true;
          }
          await pause();
        }
      }
      operation.runProcessesConfirmedGone = true;
      operation.runCleanupBlocked = false;
    } catch {
      operation.runCleanupBlocked = true;
      throw new ToolError('CANCEL_FAILED', 'Owned run process termination could not be confirmed.');
    }
  }

  async waitRunBuild(operation, instance) {
    while (!instance.closed) {
      this.checkpoint(operation);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    this.checkpoint(operation);
    if (instance.spawnError || instance.exitCode !== 0 || instance.signal) {
      throw new ToolError('COMMAND_FAILED', 'Private image construction failed; inspect the bounded host output.');
    }
  }

  async readRunConsole(operation, final = false) {
    const filename = path.join(operation.runDirectory, 'output', 'qemu.out');
    let handle;
    try {
      let before;
      try { before = await lstat(filename); }
      catch (error) {
        if (error.code === 'ENOENT' && !operation.runConsoleIdentity) {
          return { completed: false, exitCode: null };
        }
        throw error;
      }
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
          await realpath(filename) !== filename || before.size > 8 * 1024 * 1024) {
        throw new ToolError('UNSAFE_CONFIGURATION', 'Guest console file is unsafe or exceeds its monitored limit.');
      }
      const registered = operation.runConsoleIdentity;
      if (registered && (registered.dev !== before.dev || registered.ino !== before.ino)) {
        throw new ToolError('UNSAFE_CONFIGURATION', 'Guest console file was replaced.');
      }
      handle = await open(filename, constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
        throw new ToolError('UNSAFE_CONFIGURATION', 'Guest console identity changed while opening.');
      }
      operation.runConsoleIdentity ??= { dev: opened.dev, ino: opened.ino };
      operation.runConsoleOffset ??= 0;
      if (opened.size < operation.runConsoleOffset || opened.size > 8 * 1024 * 1024) {
        throw new ToolError('COMMAND_FAILED', 'Guest console was truncated or exceeded its monitored limit.');
      }
      const buffer = Buffer.alloc(65536);
      while (operation.runConsoleOffset < opened.size) {
        if (!final) this.checkpoint(operation);
        const length = Math.min(buffer.length, opened.size - operation.runConsoleOffset);
        const { bytesRead } = await handle.read(buffer, 0, length, operation.runConsoleOffset);
        if (!bytesRead) throw new ToolError('COMMAND_FAILED', 'Guest console changed while reading.');
        operation.runConsoleOffset += bytesRead;
        this.consumeRunConsole(operation, buffer.subarray(0, bytesRead));
      }
      return this.consumeRunConsole(operation, Buffer.alloc(0), final);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError('UNSAFE_CONFIGURATION', 'Guest console could not be read safely.');
    } finally {
      if (handle) await handle.close();
    }
  }

  async waitRunGuest(operation, instance) {
    while (true) {
      this.checkpoint(operation);
      const result = await this.readRunConsole(operation);
      if (result.completed) return result.exitCode;
      if (instance.closed) {
        const last = await this.readRunConsole(operation, true);
        if (last.completed) return last.exitCode;
        throw new ToolError('COMMAND_FAILED', 'QEMU closed before a valid guest completion marker.');
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  async runArtifact(operation) {
    const started = performance.now();
    const timings = { preparationMs: null, buildMs: null, guestMs: null, cleanupMs: null, totalMs: null };
    Object.assign(operation.result, {
      console: '', consoleTruncated: false, consoleBytesObserved: 0,
      buildExitCode: null, qemuExitCode: null, timings,
    });
    // Preserve an asynchronous queued response before preparation begins.
    await Promise.resolve();
    operation.result.state = 'running';
    let failure = null;
    let guestExitCode = null;
    let qemu = null;
    const phase = async (field, limit, action) => {
      this.checkpoint(operation);
      const began = performance.now();
      const timer = setTimeout(() => this.requestStop(operation, 'TIMEOUT'), limit);
      try {
        const result = await action();
        this.checkpoint(operation);
        if (performance.now() - began >= limit) {
          this.requestStop(operation, 'TIMEOUT');
          this.checkpoint(operation);
        }
        return result;
      } finally {
        clearTimeout(timer);
        timings[field] = Math.round(performance.now() - began);
      }
    };
    // Reserve the final 30 seconds of the total deadline for cleanup.
    operation.deadlineTimer = setTimeout(() => this.requestStop(operation, 'TIMEOUT'),
      Math.max(1, this.deadlines.qnx_run_artifact - 30000));
    try {
      if (process.platform !== 'linux') {
        throw new ToolError('UNSAFE_CONFIGURATION', 'Artifact execution requires Linux process ownership.');
      }
      let builder;
      await phase('preparationMs', 30000, async () => {
        builder = await findExecutable('mkqnximage', this.env);
        qemu = await findExecutable('qemu-system-x86_64', this.env);
        await this.prepareRunDirectory(operation, operation.runCompilation);
      });
      await phase('buildMs', 120000, async () => {
        const instance = await this.launchRunProcess(operation, builder, ['--noprompt', '--build'], 'build');
        await this.waitRunBuild(operation, instance);
        // Confirm the builder and its group are gone before trusting its outputs.
        await this.cleanupRunProcesses(operation, performance.now() + 30000);
        await this.validateRunImageOutputs(operation);
      });
      guestExitCode = await phase('guestMs', 60000, async () => {
        const instance = await this.launchRunProcess(operation, qemu, this.runQemuArguments(), 'guest');
        return this.waitRunGuest(operation, instance);
      });
      if (operation.result.truncated) {
        throw new ToolError('OUTPUT_LIMIT', 'Host diagnostic output exceeded its retained limit.');
      }
    } catch (error) {
      failure = error instanceof ToolError ? error :
        new ToolError('INTERNAL_ERROR', 'Artifact execution could not complete.');
    } finally {
      clearTimeout(operation.deadlineTimer);
      operation.deadlineTimer = null;
      const cleanupStarted = performance.now();
      try {
        await this.cleanupRunProcesses(operation, cleanupStarted + 30000);
        if (operation.runConsoleIdentity) {
          try {
            const last = await this.readRunConsole(operation, true);
            if (last.completed) guestExitCode = last.exitCode;
          } catch (error) {
            failure = error instanceof ToolError ? error :
              new ToolError('INTERNAL_ERROR', 'Final guest console validation failed.');
            guestExitCode = null;
          }
        }
        await this.removeOwnedRunDirectory(operation);
      } catch {
        operation.runCleanupBlocked = true;
        failure = new ToolError('CANCEL_FAILED', 'Run cleanup could not be confirmed; further mutating operations remain blocked.');
      }
      timings.cleanupMs = Math.round(performance.now() - cleanupStarted);
      timings.totalMs = Math.round(performance.now() - started);
      operation.result.exitCode = guestExitCode;
      const code = operation.runCleanupBlocked ? 'CANCEL_FAILED' :
        operation.stopReason ?? failure?.code ?? null;
      operation.result.errorCode = code;
      operation.result.state = code === 'TIMEOUT' ? 'timed_out' :
        code === 'CANCELLED' ? 'cancelled' :
        code || guestExitCode !== 0 ? 'failed' : 'succeeded';
      if (failure) operation.result.message = failure.message;
      if (!operation.runCleanupBlocked && this.mutatingOperation === operation.result.operationId) {
        this.mutatingOperation = null;
      }
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
    if (name === 'qnx_run_artifact') return this.runArtifact(operation);
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
        const registered = await lstat(canonicalOutput);
        if (!registered.isFile() || registered.isSymbolicLink() ||
            registered.dev !== outputInfo.dev || registered.ino !== outputInfo.ino ||
            registered.size !== outputInfo.size || registered.mtimeMs !== outputInfo.mtimeMs ||
            registered.ctimeMs !== outputInfo.ctimeMs) {
          throw new ToolError('UNSAFE_CONFIGURATION', 'Compiler output changed while being registered.');
        }
        operation.artifactRecord = Object.freeze({
          filename: canonicalOutput, sha256, size: registered.size,
          dev: registered.dev, ino: registered.ino,
          mtimeMs: registered.mtimeMs, ctimeMs: registered.ctimeMs,
          architecture: 'x86_64',
        });
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

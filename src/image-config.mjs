import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from './contracts.mjs';

const disabled = Object.freeze({ version: 1, enabled: false });
const MAX_CONFIG_BYTES = 4096;

// Operator configuration only. An enable request does not establish host
// isolation, instance ownership or safe networking; execution needs those
// independently verified controls as well. Never accept this through MCP.
export async function loadImageConfig(env = process.env) {
  const filename = env.QNX_MCP_IMAGE_CONFIG;
  if (filename === undefined) return disabled;
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) {
    throw new ToolError('UNSAFE_CONFIGURATION', 'QNX_MCP_IMAGE_CONFIG must be an absolute file path.');
  }

  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) throw new Error();
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_CONFIG_BYTES) throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    const config = JSON.parse(text);
    if (config === null || typeof config !== 'object' || Array.isArray(config) ||
        Object.keys(config).length !== 2 ||
        !Object.hasOwn(config, 'version') || !Object.hasOwn(config, 'enabled') ||
        config.version !== 1 || typeof config.enabled !== 'boolean') {
      throw new Error();
    }
    return Object.freeze({ version: 1, enabled: config.enabled });
  } catch {
    throw new ToolError('UNSAFE_CONFIGURATION', 'Image configuration must be a readable JSON file containing only version: 1 and a boolean enabled field.');
  } finally {
    if (handle) await handle.close();
  }
}

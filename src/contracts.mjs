export const OUTPUT_LIMIT_BYTES = 32768;
export const TERMINATION_GRACE_MS = 5000;

export const DEADLINES_MS = Object.freeze({
  qnx_toolchain_info: 30000,
  qnx_compile_c: 120000,
  qnx_image_build: 900000,
  qnx_image_start: 60000,
  qnx_image_ip: 20000,
  qnx_image_stop: 30000,
});

const emptySchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const sourceSchema = {
  type: 'object',
  properties: {
    source: {
      type: 'string',
      pattern: '^src/[A-Za-z0-9_-]+[.]c$',
      maxLength: 128,
    },
  },
  required: ['source'],
  additionalProperties: false,
};

const operationSchema = {
  type: 'object',
  properties: {
    operationId: { type: 'string', pattern: '^[a-f0-9]{32}$' },
  },
  required: ['operationId'],
  additionalProperties: false,
};

export const TOOLS = [
  {
    name: 'qnx_toolchain_info',
    description: 'Read QNX compiler version and available targets using fixed commands. Does not install or activate the SDP. Deadline: 30 seconds.',
    inputSchema: emptySchema,
  },
  {
    name: 'qnx_compile_c',
    description: 'Compile one workspace src/name.c file for QNX x86_64 with fixed compiler arguments. Never runs the resulting binary or accepts compiler flags. Deadline: 120 seconds.',
    inputSchema: sourceSchema,
  },
  {
    name: 'qnx_image_build',
    description: 'Build a fixed QEMU x86_64 image only after host isolation and persisted image configuration have been verified. Otherwise returns UNSAFE_CONFIGURATION. Deadline: 900 seconds.',
    inputSchema: emptySchema,
  },
  {
    name: 'qnx_image_start',
    description: 'Start an owned image only after process ownership and loopback-only networking have been verified. Otherwise returns UNSAFE_CONFIGURATION. Launcher success does not establish guest readiness. Deadline: 60 seconds.',
    inputSchema: emptySchema,
  },
  {
    name: 'qnx_image_ip',
    description: 'Read the address reported for an owned image using a fixed command. Requires verified image ownership and configuration; does not connect to the address. Deadline: 20 seconds.',
    inputSchema: emptySchema,
  },
  {
    name: 'qnx_image_stop',
    description: 'Stop only a verified server-owned instance. Returns UNSAFE_CONFIGURATION when ownership or command scope cannot be established. Deadline: 30 seconds.',
    inputSchema: emptySchema,
  },
  {
    name: 'qnx_operation_status',
    description: 'Read the bounded output and current state of an operation created by this server. Accepts an operation ID, never a PID or path.',
    inputSchema: operationSchema,
  },
  {
    name: 'qnx_operation_cancel',
    description: 'Request cancellation of an operation created by this server. Acceptance does not confirm process termination; poll operation status for the final state.',
    inputSchema: operationSchema,
  },
];

export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

const toolsByName = new Map(TOOLS.map(tool => [tool.name, tool]));

// Validate here as well as advertising JSON schemas: callers may bypass an
// SDK's schema validation. No caller-controlled executable or flags exist.
export function validateArguments(name, supplied) {
  const tool = toolsByName.get(name);
  if (!tool) throw new ToolError('INVALID_INPUT', 'Unknown tool.');
  const args = supplied === undefined ? {} : supplied;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolError('INVALID_INPUT', 'Arguments must be an object.');
  }
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ToolError('INVALID_INPUT', 'Arguments must be a plain object.');
  }
  const schema = tool.inputSchema;
  for (const key of Reflect.ownKeys(args)) {
    if (typeof key !== 'string' || !Object.hasOwn(schema.properties, key)) {
      throw new ToolError('INVALID_INPUT', 'Unexpected argument.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(args, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new ToolError('INVALID_INPUT', 'Argument accessors are forbidden.');
    }
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(args, key)) {
      throw new ToolError('INVALID_INPUT', `Missing ${key}.`);
    }
  }
  const validated = {};
  for (const [key, rule] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(args, key)) continue;
    const value = args[key];
    if (typeof value !== 'string' ||
        (rule.maxLength !== undefined && value.length > rule.maxLength) ||
        !new RegExp(rule.pattern).test(value)) {
      throw new ToolError('INVALID_INPUT', `Invalid ${key}.`);
    }
    validated[key] = value;
  }
  return validated;
}

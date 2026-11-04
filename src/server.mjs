#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, ToolError } from './contracts.mjs';
import { Executor } from './executor.mjs';

export function createMcpServer(executor) {
  const server = new Server(
    { name: 'qnx-host-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: structuredClone(TOOLS),
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    let result;
    try {
      result = await executor.call(request.params.name, request.params.arguments);
    } catch (error) {
      result = {
        operationId: randomBytes(16).toString('hex'),
        state: 'failed',
        exitCode: null,
        stdout: '',
        stderr: '',
        truncated: false,
        errorCode: error instanceof ToolError ? error.code : 'INTERNAL_ERROR',
        message: error instanceof ToolError ? error.message : 'The request could not complete.',
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
      isError: ['failed', 'timed_out', 'cancelled'].includes(result.state),
    };
  });

  return server;
}

export async function main() {
  const executor = await Executor.create();
  const server = createMcpServer(executor);
  const transport = new StdioServerTransport();
  let closing = null;

  const shutdown = () => {
    closing ??= (async () => {
      await executor.close();
      await server.close();
    })().finally(() => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    });
    return closing;
  };
  const onSignal = () => {
    void shutdown().catch(() => {
      process.stderr.write('QNX MCP shutdown did not complete cleanly.\n');
      process.exitCode = 1;
    });
  };

  server.onclose = onSignal;
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await server.connect(transport);
  } catch (error) {
    await shutdown();
    throw error;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main().catch(error => {
    const code = error instanceof ToolError ? error.code : 'STARTUP_FAILED';
    process.stderr.write(`QNX MCP startup failed (${code}).\n`);
    process.exitCode = 1;
  });
}

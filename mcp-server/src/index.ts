#!/usr/bin/env node
// Pinpoint MCP server — stdio entrypoint (Mission C5).
//
// Reads newline-delimited JSON-RPC requests from stdin and writes responses
// to stdout (the stdio transport MCP clients expect). Diagnostics go to
// stderr so they never corrupt the protocol stream.
//
// Configuration (env):
//   PINPOINT_API_URL — base URL of the Pinpoint API (e.g. https://…).
//   PINPOINT_API_KEY — a STANDARD org API key (`pk_…`, not `pk_widget_…`).
//
// Run: `PINPOINT_API_URL=… PINPOINT_API_KEY=… node dist/index.js`.

import { createInterface } from 'node:readline';
import { PinpointClient, PinpointConfigError } from './client.js';
import { handleLine } from './server.js';

export { PinpointClient, PinpointConfigError, PinpointApiError } from './client.js';
export { TOOLS, listTools, callTool, findTool, ToolValidationError } from './tools.js';
export { handleRpc, handleLine, PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION } from './server.js';

/** Build a client from the environment, exiting with a clear error if misconfigured. */
export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): PinpointClient {
  const apiUrl = env.PINPOINT_API_URL ?? '';
  const apiKey = env.PINPOINT_API_KEY ?? '';
  return new PinpointClient({ apiUrl, apiKey });
}

/** Start the stdio read/respond loop. */
export function main(): void {
  let client: PinpointClient;
  try {
    client = clientFromEnv();
  } catch (err) {
    const message = err instanceof PinpointConfigError ? err.message : String(err);
    process.stderr.write(`[pinpoint-mcp] configuration error: ${message}\n`);
    process.exit(1);
    return;
  }

  process.stderr.write('[pinpoint-mcp] ready (stdio transport)\n');

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    void (async () => {
      try {
        const out = await handleLine(client, line);
        if (out !== null) process.stdout.write(out + '\n');
      } catch (err) {
        process.stderr.write(`[pinpoint-mcp] unexpected error: ${String(err)}\n`);
      }
    })();
  });
  rl.on('close', () => process.exit(0));
}

// Only run the loop when executed directly (not when imported by tests).
// `import.meta.url` ends with the invoked script path under Node ESM.
const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  main();
}

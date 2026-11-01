/**
 * A minimal MCP server over stdio (initialize, ping, tools/list, tools/call):
 * all an app adapter needs, so no SDK dependency for four methods.
 */
import * as NodeReadline from "node:readline";

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly run: (args: Record<string, unknown>) => Promise<unknown>;
}

export const MCP_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: number | string | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** Handle one request. Exported so tests can drive it without stdio. */
export async function handleMcpRequest(
  server: {
    readonly name: string;
    readonly version: string;
    readonly tools: ReadonlyArray<McpTool>;
  },
  request: JsonRpcRequest,
): Promise<Record<string, unknown> | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: request.id ?? null, result });
  const error = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id: request.id ?? null,
    error: { code, message },
  });
  if (request.id === undefined || request.id === null) {
    return null; // a notification, e.g. notifications/initialized
  }
  switch (request.method) {
    case "initialize":
      return reply({
        protocolVersion:
          typeof request.params?.protocolVersion === "string"
            ? request.params.protocolVersion
            : MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: server.name, version: server.version },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: server.tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case "tools/call": {
      const name = request.params?.name;
      const tool = server.tools.find((candidate) => candidate.name === name);
      if (!tool) return error(-32602, `Unknown tool ${String(name)}.`);
      try {
        const result = await tool.run((request.params?.arguments as Record<string, unknown>) ?? {});
        return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (cause) {
        return reply({
          isError: true,
          content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }],
        });
      }
    }
    default:
      return error(-32601, `Method ${request.method} is not supported.`);
  }
}

export function serveMcpOverStdio(server: {
  readonly name: string;
  readonly version: string;
  readonly tools: ReadonlyArray<McpTool>;
}): Promise<void> {
  const lines = NodeReadline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (line.trim().length === 0) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
      );
      return;
    }
    void handleMcpRequest(server, request).then((response) => {
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });
  return new Promise((resolve) => lines.once("close", () => resolve()));
}

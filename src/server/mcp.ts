// MCP stdio server plumbing (ADR-0003: the MCP server is the spine).
// Tools are declared with JSON Schema; handlers return plain objects that
// are serialized into a single text content block.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/** Thrown by tool handlers for invalid input; becomes an isError tool result. */
export class ToolInputError extends Error {}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export function createMcpServer(opts: {
  name: string;
  version: string;
  tools: ToolSpec[];
}): Server {
  const server = new Server(
    { name: opts.name, version: opts.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: opts.tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = opts.tools.find((t) => t.name === request.params.name);
    if (!tool) {
      return {
        content: [
          { type: "text", text: `unknown tool: ${request.params.name}` },
        ],
        isError: true,
      };
    }
    try {
      const result = await tool.handler(request.params.arguments ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      if (err instanceof ToolInputError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      console.error(`purview: tool ${tool.name} failed: ${String(err)}`);
      return {
        content: [{ type: "text", text: `internal error: ${String(err)}` }],
        isError: true,
      };
    }
  });

  return server;
}

export async function connectStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("./runtime", () => ({ buildSubAgentRuntime: vi.fn() }));
vi.mock("./loaders", () => ({
  loadMcpServers: vi.fn(),
  loadSubAgents: vi.fn(),
}));

import { loadMcpServers } from "./loaders";
import { discoverMcpTools, loadMcpTools } from "./tools";

const SERVER_TOOLS = [
  {
    name: "echo",
    description: "Echoes the message back.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
  {
    name: "add",
    description: "Adds two numbers.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

// The MCP protocol versions this repo's own server route negotiates.
const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18"];

type RecordedRequest = {
  method: string;
  rpcMethod?: string;
  headers: IncomingHttpHeaders;
};

const received: RecordedRequest[] = [];

function callTool(name: string, args: Record<string, unknown>) {
  if (name === "echo")
    return { content: [{ type: "text", text: `echo: ${args.message}` }] };
  if (name === "add")
    return {
      content: [
        { type: "text", text: String(Number(args.a) + Number(args.b)) },
      ],
    };
  return null;
}

function handle(message: {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}) {
  const { id, method, params } = message;
  if (id === undefined) return null;

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion:
            typeof requested === "string" &&
            SUPPORTED_PROTOCOLS.includes(requested)
              ? requested
              : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "test-mcp", version: "1.0.0" },
        },
      };
    }
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: SERVER_TOOLS } };
    case "tools/call": {
      const name = String(params?.name);
      const output = callTool(
        name,
        (params?.arguments ?? {}) as Record<string, unknown>,
      );
      return output
        ? { jsonrpc: "2.0", id, result: output }
        : {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: `Unknown tool: ${name}` },
          };
    }
    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

let server: Server;
let serverUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    // The client opens an optional inbound SSE stream; 405 means POST-only, as the app's route answers.
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.method === "DELETE") {
      received.push({ method: "DELETE", headers: req.headers });
      res.writeHead(200).end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      received.push({
        method: "POST",
        rpcMethod: message.method,
        headers: req.headers,
      });
      const reply = handle(message);
      if (reply === null) {
        res.writeHead(202).end();
        return;
      }
      res
        .writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "test-session",
        })
        .end(JSON.stringify(reply));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

afterEach(() => {
  received.length = 0;
  vi.clearAllMocks();
});

const rpcCalls = () =>
  received.filter((r) => r.rpcMethod !== undefined).map((r) => r.rpcMethod);

describe("discoverMcpTools against a real Streamable HTTP MCP server", () => {
  it("completes the handshake and returns the server's tool definitions", async () => {
    const discovered = await discoverMcpTools({ serverUrl, authConfig: null });

    expect(discovered.map((t) => t.name)).toEqual(["echo", "add"]);
    expect(discovered[0]).toMatchObject({
      name: "echo",
      description: "Echoes the message back.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
      },
    });
    expect(rpcCalls()).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  });

  it("the authConfig headers reach the server on every request", async () => {
    await discoverMcpTools({
      serverUrl,
      authConfig: {
        headers: { authorization: "Bearer s3cr3t", "x-tenant": "acme" },
      },
    });

    const posts = received.filter((r) => r.method === "POST");
    expect(posts.length).toBeGreaterThan(0);
    for (const request of posts) {
      expect(request.headers.authorization).toBe("Bearer s3cr3t");
      expect(request.headers["x-tenant"]).toBe("acme");
    }
  });

  it("an authConfig without headers sends no Authorization at all", async () => {
    await discoverMcpTools({ serverUrl, authConfig: { type: "none" } });

    for (const request of received.filter((r) => r.method === "POST"))
      expect(request.headers.authorization).toBeUndefined();
  });
});

describe("loadMcpTools against a real Streamable HTTP MCP server", () => {
  const stubServer = (overrides: { toolNames?: string[] } = {}) =>
    vi.mocked(loadMcpServers).mockResolvedValue([
      {
        id: "server-1",
        name: "weather",
        serverUrl,
        authConfig: { headers: { authorization: "Bearer s3cr3t" } },
        toolNames: overrides.toolNames ?? ["echo", "add"],
        approvalToolNames: ["add"],
      },
    ]);

  it("exposes the selected tools under their prefixed names and runs one end to end", async () => {
    stubServer();

    const { tools, approvalToolNames, failed, clients } =
      await loadMcpTools("agent-1");
    try {
      expect(Object.keys(tools).sort()).toEqual([
        "weather__add",
        "weather__echo",
      ]);
      expect([...approvalToolNames]).toEqual(["weather__add"]);
      expect(failed).toEqual([]);

      const execute = (
        tools.weather__echo as unknown as {
          execute: (input: unknown, options: unknown) => Promise<unknown>;
        }
      ).execute;
      const output = await execute(
        { message: "hola" },
        { toolCallId: "call-1", messages: [] },
      );

      expect(output).toMatchObject({
        content: [{ type: "text", text: "echo: hola" }],
      });
      expect(rpcCalls()).toContain("tools/call");
      expect(
        received.find((r) => r.rpcMethod === "tools/call")?.headers
          .authorization,
      ).toBe("Bearer s3cr3t");
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
    }
  });

  it("a tool the server no longer offers is reported in failed, the rest still load", async () => {
    stubServer({ toolNames: ["echo", "gone"] });

    const { tools, failed, clients } = await loadMcpTools("agent-1");
    try {
      expect(Object.keys(tools)).toEqual(["weather__echo"]);
      expect(failed).toEqual(["weather (tools no longer offered: gone)"]);
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
    }
  });

  it("an unreachable server degrades softly: no tools, the name lands in failed", async () => {
    vi.mocked(loadMcpServers).mockResolvedValue([
      {
        id: "server-2",
        name: "down",
        serverUrl: "http://127.0.0.1:1/mcp",
        authConfig: null,
        toolNames: ["echo"],
        approvalToolNames: [],
      },
    ]);

    const { tools, failed, clients } = await loadMcpTools("agent-1");

    expect(tools).toEqual({});
    expect(failed).toEqual(["down"]);
    expect(clients).toEqual([]);
  });
});

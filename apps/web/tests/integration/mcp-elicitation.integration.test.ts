import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { desc } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("next/server", () => ({ after: vi.fn() }));

const migrationsFolder = fileURLToPath(
  new URL("../../../../packages/db/drizzle", import.meta.url),
);

let container: StartedPostgreSqlContainer;
let provider: Server;
let dbModule: typeof import("@agentlathe/db");
let route: typeof import("../../app/mcp/agents/[id]/route");
let agent: { id: string; name: string; slug: string };
let completions: unknown[];
let toolExecHits: number;

const toolCallCompletion = (toolName: string) => ({
  id: "gen-test",
  object: "chat.completion",
  created: 1,
  model: "test/model",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: toolName, arguments: "{}" },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
});

const textCompletion = (text: string) => ({
  id: "gen-test",
  object: "chat.completion",
  created: 1,
  model: "test/model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
});

function mcpRequest(body: unknown, sessionId?: string) {
  return new Request("http://localhost/mcp/agents/x", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

function callMcp(body: unknown, sessionId?: string) {
  return route.POST(mcpRequest(body, sessionId), {
    params: Promise.resolve({ id: agent.id }),
  });
}

type Frame = {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: { message?: string; requestedSchema?: unknown };
  result?: { content?: Array<{ text?: string }>; isError?: boolean };
};

async function readSse(
  res: Response,
  onFrame: (frame: Frame) => void | Promise<void> = () => {},
): Promise<Frame[]> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: Frame[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split: number = buffer.indexOf("\n\n");
    while (split !== -1) {
      const raw = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      if (raw.startsWith("data: ")) {
        const frame = JSON.parse(raw.slice("data: ".length)) as Frame;
        frames.push(frame);
        await onFrame(frame);
      }
      split = buffer.indexOf("\n\n");
    }
  }
  return frames;
}

async function initialize(sessionId: string, capabilities: object) {
  const res = await callMcp(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities },
    },
    sessionId,
  );
  expect(res.status).toBe(200);
}

function askAgent(sessionId?: string) {
  return callMcp(
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: dbModule.agentAskToolName(agent.slug),
        arguments: { message: "do the thing" },
      },
    },
    sessionId,
  );
}

async function latestRun() {
  const [run] = await dbModule.db
    .select()
    .from(dbModule.agentRuns)
    .orderBy(desc(dbModule.agentRuns.createdAt))
    .limit(1);
  return run;
}

describe("MCP elicitation wiring (requires Docker)", () => {
  beforeAll(async () => {
    provider = createServer((req, res) => {
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (req.url?.endsWith("/tool-exec")) {
        toolExecHits += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      req.resume();
      req.on("end", () => {
        const next = completions.shift();
        if (!next) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "script exhausted" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(next));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, resolve));
    const port = (provider.address() as AddressInfo).port;
    process.env.PROVIDER_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.PROVIDER_API_KEY = "test-key";

    container = await new PostgreSqlContainer("postgres:16").start();
    process.env.DATABASE_URL = container.getConnectionUri();

    dbModule = await import("@agentlathe/db");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(drizzle(dbModule.getPool()), { migrationsFolder });

    route = await import("../../app/mcp/agents/[id]/route");

    await dbModule.setSettings({ trackMcpRuns: true });
    const [seededAgent] = await dbModule.db
      .insert(dbModule.agents)
      .values({
        name: "elicitation-agent",
        slug: dbModule.agentSlug("elicitation-agent"),
        model: "test/model",
      })
      .returning();
    agent = seededAgent;

    const [seededTool] = await dbModule.db
      .insert(dbModule.tools)
      .values({
        name: "danger",
        description: "needs approval",
        endpoint: `http://127.0.0.1:${port}/tool-exec`,
        inputSchema: { type: "object", properties: {} },
        needsApproval: true,
      })
      .returning();
    await dbModule.db
      .insert(dbModule.agentTools)
      .values({ agentId: agent.id, toolId: seededTool.id });
  }, 60000);

  afterAll(async () => {
    await dbModule.closePool();
    await container.stop();
    await new Promise<void>((resolve, reject) =>
      provider.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(async () => {
    completions = [];
    toolExecHits = 0;
    await dbModule.db.delete(dbModule.agentRuns);
  });

  it("emits elicitation/create for an elicitation-capable session and runs the tool on accept", async () => {
    await initialize("sess-approve", { elicitation: {} });
    completions = [toolCallCompletion("danger"), textCompletion("all done")];

    const res = await askAgent("sess-approve");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const frames = await readSse(res, async (frame) => {
      if (frame.method !== "elicitation/create") return;
      expect(frame.params?.message).toContain("danger");
      expect(frame.params?.requestedSchema).toMatchObject({
        type: "object",
        required: ["approve"],
      });
      const reply = await callMcp(
        {
          jsonrpc: "2.0",
          id: frame.id,
          result: { action: "accept", content: { approve: true } },
        },
        "sess-approve",
      );
      expect(reply.status).toBe(202);
    });

    expect(
      frames.filter((frame) => frame.method === "elicitation/create"),
    ).toHaveLength(1);
    const final = frames.at(-1);
    expect(final?.id).toBe(7);
    expect(final?.result?.isError).toBe(false);
    expect(final?.result?.content?.[0]?.text).toBe("all done");
    expect(toolExecHits).toBe(1);

    const run = await latestRun();
    expect(run).toBeDefined();
    expect(run.source).toBe("mcp");
    expect(run.status).toBe("ok");
    expect(run.approvalsGranted).toBe(1);
  });

  it("auto-denies without elicitation capability: no frame, tool never executes", async () => {
    await initialize("sess-no-elicit", {});
    completions = [
      toolCallCompletion("danger"),
      textCompletion("cannot do it"),
    ];

    const frames = await readSse(await askAgent("sess-no-elicit"));

    expect(
      frames.filter((frame) => frame.method === "elicitation/create"),
    ).toHaveLength(0);
    const final = frames.at(-1);
    expect(final?.result?.isError).toBe(false);
    expect(final?.result?.content?.[0]?.text).toBe("cannot do it");
    expect(toolExecHits).toBe(0);
  });

  it("answers with isError and records an errored run when the model call fails", async () => {
    await initialize("sess-provider-down", { elicitation: {} });
    // An empty script makes the stub provider answer 500 to every completion.
    completions = [];

    const frames = await readSse(await askAgent("sess-provider-down"));

    expect(
      frames.filter((frame) => frame.method === "elicitation/create"),
    ).toHaveLength(0);
    const final = frames.at(-1);
    expect(final?.id).toBe(7);
    expect(final?.result?.isError).toBe(true);
    expect(final?.result?.content?.[0]?.text).toContain("The agent failed:");
    expect(toolExecHits).toBe(0);

    const run = await latestRun();
    expect(run).toBeDefined();
    expect(run.source).toBe("mcp");
    expect(run.status).toBe("error");
    expect(run.error).toBeTruthy();
  });

  it("auto-denies when the client omits the mcp-session-id header", async () => {
    await initialize("sess-header-lost", { elicitation: {} });
    completions = [toolCallCompletion("danger"), textCompletion("no session")];

    const frames = await readSse(await askAgent());

    expect(
      frames.filter((frame) => frame.method === "elicitation/create"),
    ).toHaveLength(0);
    expect(frames.at(-1)?.result?.content?.[0]?.text).toBe("no session");
    expect(toolExecHits).toBe(0);
  });
});

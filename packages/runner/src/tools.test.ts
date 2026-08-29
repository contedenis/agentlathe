import {
  jsonSchema,
  stepCountIs,
  type Tool,
  ToolLoopAgent,
  type ToolSet,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./loaders", () => ({
  loadSubAgents: vi.fn(),
  loadMcpServers: vi.fn(),
}));
vi.mock("@ai-sdk/mcp", () => ({ createMCPClient: vi.fn() }));
vi.mock("@agentlathe/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  db: { select: vi.fn() },
  agentTools: {},
  tools: {},
}));
vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  and: vi.fn(),
  eq: vi.fn(),
}));

import { db } from "@agentlathe/db";
import { createMCPClient } from "@ai-sdk/mcp";
import { buildHeadlessToolApproval } from "./approval";
import { addTool } from "./helpers";
import { loadMcpServers, loadSubAgents } from "./loaders";
import { createRunStatsCollector } from "./recording";
import {
  type BuildSubAgentRuntime,
  buildSubAgentTools,
  buildTools,
  discoverMcpTools,
  loadHttpTools,
  loadMcpTools,
  type ToolKind,
} from "./tools";

const buildSubAgentRuntime = vi.fn<BuildSubAgentRuntime>();

type HttpRow = {
  name: string;
  description: string;
  endpoint: string;
  inputSchema: unknown;
  needsApproval: boolean;
};
const stubHttpRows = (rows: HttpRow[]) =>
  vi.mocked(db.select).mockReturnValue({
    from: () => ({ innerJoin: () => ({ where: () => Promise.resolve(rows) }) }),
  } as unknown as ReturnType<typeof db.select>);

type ExecFn = (input: unknown, options: unknown) => Promise<unknown>;
const execOf = (t: Tool): ExecFn =>
  (t as unknown as { execute: ExecFn }).execute;
const baseOptions = (abortSignal?: AbortSignal) => ({
  toolCallId: "call-1",
  messages: [],
  context: undefined,
  abortSignal,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildSubAgentTools — recursion guards", () => {
  it("cycle: if the callStack already holds the child, returns an error and does NOT call buildSubAgentRuntime", async () => {
    vi.mocked(loadSubAgents).mockResolvedValue([
      {
        id: "child-1",
        name: "Child One",
        slug: "child-one",
        description: "A child",
      },
    ]);

    const ctx = {
      callStack: new Set(["parent", "child-1"]),
      depth: 0,
      subAgentBudget: { remaining: 20 },
    };
    const toolset = await buildSubAgentTools(
      "parent",
      ctx,
      buildSubAgentRuntime,
    );

    const result = await execOf(toolset["subagent_child-one"])(
      { task: "hacer algo" },
      baseOptions(),
    );

    expect(result).toBe("Error: sub-agent cycle detected.");
    expect(buildSubAgentRuntime).not.toHaveBeenCalled();
  });

  it("MAX_DEPTH: with depth >= 5 returns the depth error and does NOT call buildSubAgentRuntime", async () => {
    vi.mocked(loadSubAgents).mockResolvedValue([
      {
        id: "child-1",
        name: "Child One",
        slug: "child-one",
        description: null,
      },
    ]);

    const ctx = {
      callStack: new Set(["parent"]),
      depth: 5,
      subAgentBudget: { remaining: 20 },
    };
    const toolset = await buildSubAgentTools(
      "parent",
      ctx,
      buildSubAgentRuntime,
    );

    const result = await execOf(toolset["subagent_child-one"])(
      { task: "x" },
      baseOptions(),
    );

    expect(result).toBe("Error: maximum sub-agent depth exceeded.");
    expect(buildSubAgentRuntime).not.toHaveBeenCalled();
  });

  it("callStack is NOT shared: two sibling branches cannot see each other's childId (Set is copied)", async () => {
    vi.mocked(loadSubAgents).mockResolvedValue([
      { id: "A", name: "Alpha", slug: "alpha", description: null },
      { id: "B", name: "Beta", slug: "beta", description: null },
    ]);
    vi.mocked(buildSubAgentRuntime).mockImplementation(
      async (id: string) =>
        ({
          agent: { generate: vi.fn().mockResolvedValue({ text: `ran ${id}` }) },
          cleanup: async () => {},
        }) as unknown as Awaited<ReturnType<typeof buildSubAgentRuntime>>,
    );

    const ctx = {
      callStack: new Set(["root"]),
      depth: 0,
      subAgentBudget: { remaining: 20 },
    };
    const toolset = await buildSubAgentTools("root", ctx, buildSubAgentRuntime);

    const textA = await execOf(toolset.subagent_alpha)(
      { task: "a" },
      baseOptions(),
    );
    const textB = await execOf(toolset.subagent_beta)(
      { task: "b" },
      baseOptions(),
    );

    expect(textA).toBe("ran A");
    expect(textB).toBe("ran B");

    const calls = vi.mocked(buildSubAgentRuntime).mock.calls;
    const ctxA = calls[0][1];
    const ctxB = calls[1][1];

    expect(ctxA.callStack.has("A")).toBe(true);
    expect(ctxA.callStack.has("B")).toBe(false);
    expect(ctxA.depth).toBe(1);

    expect(ctxB.callStack.has("B")).toBe(true);
    expect(ctxB.callStack.has("A")).toBe(false);

    expect([...ctx.callStack]).toEqual(["root"]);
  });

  it("security: the child runtime is built with the headless strategy → a needs_approval tool is denied, not executed", async () => {
    vi.mocked(loadSubAgents).mockResolvedValue([
      {
        id: "child-1",
        name: "Child One",
        slug: "child-one",
        description: null,
      },
    ]);
    vi.mocked(buildSubAgentRuntime).mockResolvedValue({
      agent: { generate: vi.fn().mockResolvedValue({ text: "ok" }) },
      cleanup: async () => {},
    } as unknown as Awaited<ReturnType<typeof buildSubAgentRuntime>>);

    const ctx = {
      callStack: new Set(["parent"]),
      depth: 0,
      subAgentBudget: { remaining: 20 },
    };
    const toolset = await buildSubAgentTools(
      "parent",
      ctx,
      buildSubAgentRuntime,
    );
    await execOf(toolset["subagent_child-one"])({ task: "x" }, baseOptions());

    const options = vi.mocked(buildSubAgentRuntime).mock.calls[0][2];
    expect(options?.buildApproval).toBe(buildHeadlessToolApproval);

    const approval = options?.buildApproval?.(new Set(["danger"])) as (opts: {
      toolCall: { toolName: string };
    }) => unknown;
    expect(approval({ toolCall: { toolName: "danger" } })).toMatchObject({
      type: "denied",
    });
  });
});

describe("buildSubAgentTools — child stats reporting", () => {
  it("after a child run, onChildStats receives the child's snapshot", async () => {
    vi.mocked(loadSubAgents).mockResolvedValue([
      {
        id: "child-1",
        name: "Child One",
        slug: "child-one",
        description: null,
      },
    ]);
    const childStats = {
      steps: 3,
      toolCalls: 2,
      inputTokens: 100,
      outputTokens: 40,
      approvalsRequested: 0,
      approvalsGranted: 0,
      calls: [],
      mcpFailures: [],
    };
    vi.mocked(buildSubAgentRuntime).mockResolvedValue({
      agent: { generate: vi.fn().mockResolvedValue({ text: "ok" }) },
      cleanup: async () => {},
      stats: () => childStats,
    } as unknown as Awaited<ReturnType<typeof buildSubAgentRuntime>>);
    const onChildStats = vi.fn();

    const toolset = await buildSubAgentTools(
      "parent",
      {
        callStack: new Set(["parent"]),
        depth: 0,
        subAgentBudget: { remaining: 20 },
      },
      buildSubAgentRuntime,
      onChildStats,
    );
    await execOf(toolset["subagent_child-one"])({ task: "x" }, baseOptions());

    expect(onChildStats).toHaveBeenCalledWith(childStats);
  });
});

describe("buildSubAgentTools — fan-out budget", () => {
  const oneChildRuntime = () => {
    vi.mocked(loadSubAgents).mockResolvedValue([
      {
        id: "child-1",
        name: "Child One",
        slug: "child-one",
        description: null,
      },
    ]);
    vi.mocked(buildSubAgentRuntime).mockResolvedValue({
      agent: { generate: vi.fn().mockResolvedValue({ text: "ok" }) },
      cleanup: async () => {},
    } as unknown as Awaited<ReturnType<typeof buildSubAgentRuntime>>);
  };

  it("an exhausted budget returns a soft error instead of building the child", async () => {
    oneChildRuntime();
    const ctx = {
      callStack: new Set(["parent"]),
      depth: 0,
      subAgentBudget: { remaining: 2 },
    };
    const toolset = await buildSubAgentTools(
      "parent",
      ctx,
      buildSubAgentRuntime,
    );
    const exec = execOf(toolset["subagent_child-one"]);

    expect(await exec({ task: "1" }, baseOptions())).toBe("ok");
    expect(await exec({ task: "2" }, baseOptions())).toBe("ok");
    expect(await exec({ task: "3" }, baseOptions())).toBe(
      "Error: sub-agent call budget for this run is exhausted.",
    );
    expect(buildSubAgentRuntime).toHaveBeenCalledTimes(2);
  });

  it("the budget object is shared by reference with the child context", async () => {
    oneChildRuntime();
    const ctx = {
      callStack: new Set(["parent"]),
      depth: 0,
      subAgentBudget: { remaining: 5 },
    };
    const toolset = await buildSubAgentTools(
      "parent",
      ctx,
      buildSubAgentRuntime,
    );
    await execOf(toolset["subagent_child-one"])({ task: "x" }, baseOptions());

    const childCtx = vi.mocked(buildSubAgentRuntime).mock.calls[0][1];
    expect(childCtx.subAgentBudget).toBe(ctx.subAgentBudget);
    expect(ctx.subAgentBudget.remaining).toBe(4);
  });
});

describe("loadMcpTools — resilience, prefix and explicit selection", () => {
  it("a failed server does not abort the rest; the live client is returned for cleanup and the failed one is closed", async () => {
    const closeOk = vi.fn().mockResolvedValue(undefined);
    const closeFail = vi.fn().mockResolvedValue(undefined);

    vi.mocked(loadMcpServers).mockResolvedValue([
      {
        id: "c1",
        name: "Good Server",
        serverUrl: "http://good",
        authConfig: null,
        approvalToolNames: [],
        toolNames: ["search"],
      },
      {
        id: "c2",
        name: "Bad Server",
        serverUrl: "http://bad",
        authConfig: null,
        approvalToolNames: [],
        toolNames: ["whatever"],
      },
    ]);

    vi.mocked(createMCPClient).mockImplementation(async (config) => {
      const url = (config.transport as { url: string }).url;
      if (url === "http://good") {
        return {
          tools: vi.fn().mockResolvedValue({
            search: { description: "search tool" },
            other: { description: "not selected" },
          }),
          close: closeOk,
        } as unknown as Awaited<ReturnType<typeof createMCPClient>>;
      }
      return {
        tools: vi.fn().mockRejectedValue(new Error("boom")),
        close: closeFail,
      } as unknown as Awaited<ReturnType<typeof createMCPClient>>;
    });

    const { tools, failed, clients } = await loadMcpTools("agent");

    expect(Object.keys(tools)).toEqual(["Good_Server__search"]);
    expect(failed).toEqual(["Bad Server"]);
    expect(closeOk).not.toHaveBeenCalled();
    expect(closeFail).toHaveBeenCalledTimes(1);
    expect(clients).toHaveLength(1);
  });

  it("a server that never opens a client is reported as failed without breaking", async () => {
    vi.mocked(loadMcpServers).mockResolvedValue([
      {
        id: "c1",
        name: "Down",
        serverUrl: "http://down",
        authConfig: null,
        approvalToolNames: [],
        toolNames: ["x"],
      },
    ]);
    vi.mocked(createMCPClient).mockRejectedValue(new Error("ECONNREFUSED"));

    const { tools, failed } = await loadMcpTools("agent");

    expect(tools).toEqual({});
    expect(failed).toEqual(["Down"]);
  });

  it("a server that connects but no longer offers a selected tool reports it in the same failures channel", async () => {
    vi.mocked(loadMcpServers).mockResolvedValue([
      {
        id: "c1",
        name: "Deploy Bot",
        serverUrl: "http://bot",
        authConfig: null,
        approvalToolNames: [],
        toolNames: ["deploy", "status"],
      },
    ]);
    vi.mocked(createMCPClient).mockResolvedValue({
      tools: vi.fn().mockResolvedValue({ status: { description: "s" } }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof createMCPClient>>);

    const { tools, failed } = await loadMcpTools("agent");

    expect(Object.keys(tools)).toEqual(["Deploy_Bot__status"]);
    expect(failed).toEqual(["Deploy Bot (tools no longer offered: deploy)"]);
  });
});

describe("loadMcpTools — approval gate for MCP tools", () => {
  it("a tool marked needs_approval lands in approvalToolNames under its final name", async () => {
    vi.mocked(loadMcpServers).mockResolvedValue([
      {
        id: "c1",
        name: "Server",
        serverUrl: "http://x",
        authConfig: null,
        approvalToolNames: ["deploy"],
        toolNames: ["deploy", "read"],
      },
    ]);
    vi.mocked(createMCPClient).mockResolvedValue({
      tools: vi.fn().mockResolvedValue({
        deploy: { description: "d" },
        read: { description: "r" },
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof createMCPClient>>);

    const { approvalToolNames } = await loadMcpTools("agent");

    expect(approvalToolNames).toEqual(new Set(["Server__deploy"]));
  });

  it("a collision rename carries the gate to the final name", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(loadMcpServers).mockResolvedValue([
      {
        id: "c1",
        name: "My Server",
        serverUrl: "http://a",
        authConfig: null,
        approvalToolNames: [],
        toolNames: ["deploy"],
      },
      {
        id: "c2",
        name: "My!Server",
        serverUrl: "http://b",
        authConfig: null,
        approvalToolNames: ["deploy"],
        toolNames: ["deploy"],
      },
    ]);
    vi.mocked(createMCPClient).mockResolvedValue({
      tools: vi.fn().mockResolvedValue({ deploy: { description: "d" } }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof createMCPClient>>);

    const { tools, approvalToolNames } = await loadMcpTools("agent");

    expect(Object.keys(tools).sort()).toEqual([
      "My_Server__deploy",
      "My_Server__deploy_2",
    ]);
    expect(approvalToolNames).toEqual(new Set(["My_Server__deploy_2"]));
    warn.mockRestore();
  });
});

describe("buildTools — approval names union across sources", () => {
  it("http and mcp approval names merge, both under their final names", async () => {
    stubHttpRows([
      {
        name: "danger",
        description: "d",
        endpoint: "http://x",
        inputSchema: { type: "object" },
        needsApproval: true,
      },
    ]);
    vi.mocked(loadSubAgents).mockResolvedValue([]);
    vi.mocked(loadMcpServers).mockResolvedValue([
      {
        id: "c1",
        name: "Server",
        serverUrl: "http://x",
        authConfig: null,
        approvalToolNames: ["deploy"],
        toolNames: ["deploy"],
      },
    ]);
    vi.mocked(createMCPClient).mockResolvedValue({
      tools: vi.fn().mockResolvedValue({ deploy: { description: "d" } }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof createMCPClient>>);

    const { approvalToolNames } = await buildTools(
      "agent",
      {
        callStack: new Set(["agent"]),
        depth: 0,
        subAgentBudget: { remaining: 20 },
      },
      buildSubAgentRuntime,
    );

    expect(approvalToolNames).toEqual(new Set(["danger", "Server__deploy"]));
  });
});

describe("loadMcpTools — connect timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("createMCPClient that never resolves → after 30s the server is reported as failed", async () => {
    vi.mocked(loadMcpServers).mockResolvedValue([
      {
        id: "c1",
        name: "Stuck",
        serverUrl: "http://stuck",
        authConfig: null,
        approvalToolNames: [],
        toolNames: ["x"],
      },
    ]);
    vi.mocked(createMCPClient).mockImplementation(() => new Promise(() => {}));

    const resultPromise = loadMcpTools("agent");
    await vi.advanceTimersByTimeAsync(30_000);
    const { tools, failed } = await resultPromise;

    expect(tools).toEqual({});
    expect(failed).toEqual(["Stuck"]);
  });

  it("client.tools() that never resolves → after 30s reported failed and the client is closed", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(loadMcpServers).mockResolvedValue([
      {
        id: "c1",
        name: "Stuck",
        serverUrl: "http://stuck",
        authConfig: null,
        approvalToolNames: [],
        toolNames: ["x"],
      },
    ]);
    vi.mocked(createMCPClient).mockResolvedValue({
      tools: vi.fn().mockImplementation(() => new Promise(() => {})),
      close,
    } as unknown as Awaited<ReturnType<typeof createMCPClient>>);

    const resultPromise = loadMcpTools("agent");
    await vi.advanceTimersByTimeAsync(30_000);
    const { failed } = await resultPromise;

    expect(failed).toEqual(["Stuck"]);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("MCP tool execute — 60s call timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a tool call that never resolves → after 60s throws the timeout instead of hanging", async () => {
    vi.mocked(loadMcpServers).mockResolvedValue([
      {
        id: "c1",
        name: "Server",
        serverUrl: "http://x",
        authConfig: null,
        approvalToolNames: [],
        toolNames: ["search"],
      },
    ]);
    vi.mocked(createMCPClient).mockResolvedValue({
      tools: vi.fn().mockResolvedValue({
        search: {
          description: "s",
          execute: () => new Promise(() => {}),
        },
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof createMCPClient>>);

    const { tools } = await loadMcpTools("agent");
    const exec = execOf(tools.Server__search);

    const settled = exec({ q: "hi" }, baseOptions()).then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await settled;

    expect(error).toBeInstanceOf(Error);
    // String(error) is verbatim what the SDK hands the model.
    expect(String(error)).toBe("Error: MCP tool call timed out");
  });

  it("a normal tool error still propagates unchanged (not swallowed as a timeout)", async () => {
    vi.mocked(loadMcpServers).mockResolvedValue([
      {
        id: "c1",
        name: "Server",
        serverUrl: "http://x",
        authConfig: null,
        approvalToolNames: [],
        toolNames: ["search"],
      },
    ]);
    vi.mocked(createMCPClient).mockResolvedValue({
      tools: vi.fn().mockResolvedValue({
        search: {
          description: "s",
          execute: async () => {
            throw new Error("boom");
          },
        },
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof createMCPClient>>);

    const { tools } = await loadMcpTools("agent");
    const exec = execOf(tools.Server__search);

    await expect(exec({ q: "hi" }, baseOptions())).rejects.toThrow("boom");
  });
});

describe("discoverMcpTools — raw discovery, closes the client", () => {
  it("returns the tools from listTools() as-is and closes the client", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createMCPClient).mockResolvedValue({
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            name: "search",
            description: "buscar",
            inputSchema: { type: "object" },
          },
        ],
      }),
      close,
    } as unknown as Awaited<ReturnType<typeof createMCPClient>>);

    const result = await discoverMcpTools({
      serverUrl: "http://x",
      authConfig: null,
    });

    expect(result).toEqual([
      {
        name: "search",
        description: "buscar",
        inputSchema: { type: "object" },
      },
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the client in finally even if listTools() rejects", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createMCPClient).mockResolvedValue({
      listTools: vi.fn().mockRejectedValue(new Error("boom")),
      close,
    } as unknown as Awaited<ReturnType<typeof createMCPClient>>);

    await expect(
      discoverMcpTools({ serverUrl: "http://x", authConfig: null }),
    ).rejects.toThrow("boom");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a client that never opens → gives up after 30s instead of hanging the dashboard", async () => {
    vi.useFakeTimers();
    vi.mocked(createMCPClient).mockImplementation(() => new Promise(() => {}));

    const settled = discoverMcpTools({
      serverUrl: "http://stuck",
      authConfig: null,
    }).then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(30_000);

    expect(String(await settled)).toBe(
      "Error: MCP server connection timed out",
    );
    vi.useRealTimers();
  });

  it("a listTools() that never resolves → gives up after 30s and still closes the client", async () => {
    vi.useFakeTimers();
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createMCPClient).mockResolvedValue({
      listTools: vi.fn().mockImplementation(() => new Promise(() => {})),
      close,
    } as unknown as Awaited<ReturnType<typeof createMCPClient>>);

    const settled = discoverMcpTools({
      serverUrl: "http://stuck",
      authConfig: null,
    }).then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(30_000);

    expect(String(await settled)).toBe(
      "Error: MCP server connection timed out",
    );
    expect(close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("addTool — deterministic collision resolution", () => {
  it("free name: uses it as-is and does not warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = {} as Parameters<typeof addTool>[0];
    const marker = {} as Parameters<typeof addTool>[2];

    expect(addTool(target, "search", marker)).toBe("search");
    expect(target.search).toBe(marker);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("collision: numbered suffix _2, _3, ... and console.warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = {} as Parameters<typeof addTool>[0];
    const a = { a: 1 } as unknown as Parameters<typeof addTool>[2];
    const b = { b: 2 } as unknown as Parameters<typeof addTool>[2];
    const c = { c: 3 } as unknown as Parameters<typeof addTool>[2];

    expect(addTool(target, "dup", a)).toBe("dup");
    expect(addTool(target, "dup", b)).toBe("dup_2");
    expect(addTool(target, "dup", c)).toBe("dup_3");
    expect(Object.keys(target)).toEqual(["dup", "dup_2", "dup_3"]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe("loadMcpTools — prefix collisions across servers", () => {
  it("two servers slugging to the same prefix that share a tool → the second gets a suffix, nothing is overwritten", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(loadMcpServers).mockResolvedValue([
      {
        id: "c1",
        name: "My Server",
        serverUrl: "http://a",
        authConfig: null,
        approvalToolNames: [],
        toolNames: ["search"],
      },
      {
        id: "c2",
        name: "My!Server",
        serverUrl: "http://b",
        authConfig: null,
        approvalToolNames: [],
        toolNames: ["search"],
      },
    ]);
    vi.mocked(createMCPClient).mockResolvedValue({
      tools: vi.fn().mockResolvedValue({ search: { description: "s" } }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof createMCPClient>>);

    const { tools } = await loadMcpTools("agent");

    expect(Object.keys(tools).sort()).toEqual([
      "My_Server__search",
      "My_Server__search_2",
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("buildSubAgentTools — sub-agents slugging to the same name", () => {
  it("two children slugging to the same name → the second gets a suffix, both survive", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(loadSubAgents).mockResolvedValue([
      { id: "a", name: "Child One", slug: "child_one", description: null },
      { id: "b", name: "Child.One", slug: "child.one", description: null },
    ]);

    const toolset = await buildSubAgentTools(
      "parent",
      {
        callStack: new Set(["parent"]),
        depth: 0,
        subAgentBudget: { remaining: 20 },
      },
      buildSubAgentRuntime,
    );

    expect(Object.keys(toolset).sort()).toEqual([
      "subagent_child_one",
      "subagent_child_one_2",
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("buildTools — merging sources with a collision", () => {
  it("an http tool and a sub-agent producing the same name → http wins, the sub-agent gets a suffix", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubHttpRows([
      {
        name: "subagent_bot",
        description: "http",
        endpoint: "http://x",
        inputSchema: { type: "object" },
        needsApproval: false,
      },
    ]);
    vi.mocked(loadMcpServers).mockResolvedValue([]);
    vi.mocked(loadSubAgents).mockResolvedValue([
      { id: "bot", name: "Bot", slug: "bot", description: null },
    ]);

    const { tools } = await buildTools(
      "agent",
      {
        callStack: new Set(["agent"]),
        depth: 0,
        subAgentBudget: { remaining: 20 },
      },
      buildSubAgentRuntime,
    );

    expect(Object.keys(tools).sort()).toEqual([
      "subagent_bot",
      "subagent_bot_2",
    ]);
    warn.mockRestore();
  });
});

describe("makeMcpCleanup — through the cleanup from buildTools", () => {
  const twoServers = () => {
    stubHttpRows([]);
    vi.mocked(loadSubAgents).mockResolvedValue([]);
    vi.mocked(loadMcpServers).mockResolvedValue([
      {
        id: "c1",
        name: "Alpha",
        serverUrl: "http://alpha",
        authConfig: null,
        approvalToolNames: [],
        toolNames: ["search"],
      },
      {
        id: "c2",
        name: "Beta",
        serverUrl: "http://beta",
        authConfig: null,
        approvalToolNames: [],
        toolNames: ["search"],
      },
    ]);
  };

  it("idempotency: two cleanup invocations close each client exactly once", async () => {
    twoServers();
    const closeA = vi.fn().mockResolvedValue(undefined);
    const closeB = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createMCPClient).mockImplementation(async (config) => {
      const url = (config.transport as { url: string }).url;
      return {
        tools: vi.fn().mockResolvedValue({ search: { description: "s" } }),
        close: url === "http://alpha" ? closeA : closeB,
      } as unknown as Awaited<ReturnType<typeof createMCPClient>>;
    });

    const { cleanup } = await buildTools(
      "agent",
      {
        callStack: new Set(["agent"]),
        depth: 0,
        subAgentBudget: { remaining: 20 },
      },
      buildSubAgentRuntime,
    );

    await cleanup();
    await cleanup();

    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
  });

  it("a rejecting close does not block the others; cleanup still resolves", async () => {
    twoServers();
    const closeFail = vi.fn().mockRejectedValue(new Error("close boom"));
    const closeOk = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createMCPClient).mockImplementation(async (config) => {
      const url = (config.transport as { url: string }).url;
      return {
        tools: vi.fn().mockResolvedValue({ search: { description: "s" } }),
        close: url === "http://alpha" ? closeFail : closeOk,
      } as unknown as Awaited<ReturnType<typeof createMCPClient>>;
    });

    const { cleanup } = await buildTools(
      "agent",
      {
        callStack: new Set(["agent"]),
        depth: 0,
        subAgentBudget: { remaining: 20 },
      },
      buildSubAgentRuntime,
    );

    await expect(cleanup()).resolves.toBeUndefined();
    expect(closeFail).toHaveBeenCalledTimes(1);
    expect(closeOk).toHaveBeenCalledTimes(1);
  });
});

describe("buildTools — a sibling failure closes the MCP clients that already connected", () => {
  const oneServer = (close: () => Promise<void>) => {
    vi.mocked(loadMcpServers).mockResolvedValue([
      {
        id: "c1",
        name: "Alpha",
        serverUrl: "http://alpha",
        authConfig: null,
        approvalToolNames: [],
        toolNames: ["search"],
      },
    ]);
    vi.mocked(createMCPClient).mockResolvedValue({
      tools: vi.fn().mockResolvedValue({ search: { description: "s" } }),
      close,
    } as unknown as Awaited<ReturnType<typeof createMCPClient>>);
  };

  it("http load rejects → the connected client is closed and the original error propagates", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    oneServer(close);
    vi.mocked(db.select).mockReturnValue({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.reject(new Error("db down")),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);
    vi.mocked(loadSubAgents).mockResolvedValue([]);

    await expect(
      buildTools(
        "agent",
        {
          callStack: new Set(["agent"]),
          depth: 0,
          subAgentBudget: { remaining: 20 },
        },
        buildSubAgentRuntime,
      ),
    ).rejects.toThrow("db down");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("sub-agent load rejects → the connected client is closed and the original error propagates", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    oneServer(close);
    stubHttpRows([]);
    vi.mocked(loadSubAgents).mockRejectedValue(new Error("agent vanished"));

    await expect(
      buildTools(
        "agent",
        {
          callStack: new Set(["agent"]),
          depth: 0,
          subAgentBudget: { remaining: 20 },
        },
        buildSubAgentRuntime,
      ),
    ).rejects.toThrow("agent vanished");
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("loadHttpTools — res.ok, error with status+body and a signal with timeout", () => {
  const execOfHttp = async (needsApproval = false) => {
    stubHttpRows([
      {
        name: "call_api",
        description: "d",
        endpoint: "http://api",
        inputSchema: { type: "object" },
        needsApproval,
      },
    ]);
    const { tools, approvalToolNames } = await loadHttpTools("agent");
    return { exec: execOf(tools.call_api), approvalToolNames };
  };

  it("non-ok response → throws with status and body, so the call is recorded failed and the model still sees the detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom internal",
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const { exec } = await execOfHttp();
    const error = await exec({ q: 1 }, baseOptions()).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    // String(error) is verbatim what the SDK hands the model.
    expect(String(error)).toBe("Error: HTTP 500: boom internal");
    vi.unstubAllGlobals();
  });

  it("the endpoint timing out → throws a timeout, not the raw abort", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url, opts) => {
        const signal = (opts as { signal: AbortSignal }).signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }),
    );
    vi.useFakeTimers();

    const { exec } = await execOfHttp();
    const settled = exec({ q: 1 }, baseOptions()).then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await settled;

    expect(String(error)).toBe(
      "Error: The tool endpoint did not respond within 30s.",
    );
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("the caller cancelling the run → the abort propagates untouched, not mislabelled as a timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url, opts) => {
        const signal = (opts as { signal: AbortSignal }).signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }),
    );

    const { exec } = await execOfHttp();
    const abort = new AbortController();
    const settled = exec({ q: 1 }, baseOptions(abort.signal)).then(
      () => null,
      (err: unknown) => err,
    );
    abort.abort(new Error("run cancelled"));
    const error = await settled;

    expect(String(error)).toBe("Error: run cancelled");
    vi.unstubAllGlobals();
  });

  it("ok response → returns the raw body and passes an AbortSignal (its own timeout) to fetch", async () => {
    let capturedSignal: unknown;
    const fetchMock = vi.fn().mockImplementation((_url, opts) => {
      capturedSignal = (opts as { signal?: unknown }).signal;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => "dato",
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { exec } = await execOfHttp();
    const abort = new AbortController();
    const result = await exec({ q: 1 }, baseOptions(abort.signal));

    expect(result).toBe("dato");
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    vi.unstubAllGlobals();
  });
});

function bodyResponse(
  text: string,
  opts: { ok?: boolean; status?: number } = {},
): Response {
  const bytes = new TextEncoder().encode(text);
  const chunkSize = 8 * 1024;
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const chunk = bytes.slice(offset, offset + chunkSize);
      offset += chunk.length;
      controller.enqueue(chunk);
    },
  });
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    body: stream,
  } as unknown as Response;
}

describe("loadHttpTools — caps the response body at 256 KB", () => {
  const execOfHttp = async () => {
    stubHttpRows([
      {
        name: "call_api",
        description: "d",
        endpoint: "http://api",
        inputSchema: { type: "object" },
        needsApproval: false,
      },
    ]);
    const { tools } = await loadHttpTools("agent");
    return execOf(tools.call_api);
  };

  it("a short response is returned intact, with no truncation suffix", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(bodyResponse("hola mundo")),
    );

    const exec = await execOfHttp();
    const result = await exec({ q: 1 }, baseOptions());

    expect(result).toBe("hola mundo");
    vi.unstubAllGlobals();
  });

  it("a response over 256 KB is cut at the cap and gets the [truncated] suffix", async () => {
    const big = "x".repeat(300 * 1024);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bodyResponse(big)));

    const exec = await execOfHttp();
    const result = (await exec({ q: 1 }, baseOptions())) as string;

    expect(result.endsWith("[truncated]")).toBe(true);
    expect(result.length).toBe(256 * 1024 + "[truncated]".length);
    vi.unstubAllGlobals();
  });
});

describe("loadHttpTools — the declared input schema is enforced", () => {
  type SchemaWithValidate = {
    validate?: (value: unknown) => { success: boolean };
  };

  it("the tool's schema validates model input: mismatches fail, matches pass", async () => {
    stubHttpRows([
      {
        name: "pay",
        description: "d",
        endpoint: "http://api",
        inputSchema: {
          type: "object",
          properties: { amount: { type: "number" } },
          required: ["amount"],
          additionalProperties: false,
        },
        needsApproval: false,
      },
    ]);

    const { tools } = await loadHttpTools("agent");
    const schema = tools.pay.inputSchema as SchemaWithValidate;

    expect(schema.validate?.({ amount: 5 })).toMatchObject({ success: true });
    expect(schema.validate?.({ amount: "1e9" })).toMatchObject({
      success: false,
    });
    expect(schema.validate?.({ amount: 5, extra: 1 })).toMatchObject({
      success: false,
    });
  });

  it("an uncompilable stored schema falls back to no validation, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubHttpRows([
      {
        name: "legacy",
        description: "d",
        endpoint: "http://api",
        inputSchema: { type: "not-a-type" },
        needsApproval: false,
      },
    ]);

    const { tools } = await loadHttpTools("agent");
    const schema = tools.legacy.inputSchema as SchemaWithValidate;

    expect(schema.validate).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid input schema"),
    );
    warn.mockRestore();
  });
});

describe("loadHttpTools — names the provider will accept", () => {
  const httpRow = (name: string, needsApproval = false): HttpRow => ({
    name,
    description: "d",
    endpoint: "http://api",
    inputSchema: { type: "object" },
    needsApproval,
  });

  it("spaces and accents: the model gets a slug, never the raw name", async () => {
    stubHttpRows([httpRow("Test webhook"), httpRow("Búsqueda de café")]);

    const { tools } = await loadHttpTools("agent");

    expect(Object.keys(tools)).toEqual(["Test_webhook", "Busqueda_de_cafe"]);
    for (const name of Object.keys(tools))
      expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it("a name with nothing to slug still yields a usable name", async () => {
    stubHttpRows([httpRow("🙂")]);

    const { tools } = await loadHttpTools("agent");

    expect(Object.keys(tools)).toEqual(["tool"]);
  });

  it("two names that slug the same are disambiguated, and approval follows the final name", async () => {
    stubHttpRows([httpRow("Test webhook"), httpRow("Test/webhook", true)]);

    const { tools, approvalToolNames } = await loadHttpTools("agent");

    expect(Object.keys(tools)).toEqual(["Test_webhook", "Test_webhook_2"]);
    expect(approvalToolNames).toEqual(new Set(["Test_webhook_2"]));
  });
});

describe("a failed tool call is recorded as an error call, whatever made it fail", () => {
  const usage = (input: number, output: number) => ({
    inputTokens: {
      total: input,
      noCache: input,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: output, text: output, reasoning: undefined },
  });

  const runOneToolCall = (toolset: ToolSet, toolName: string) => {
    const collector = createRunStatsCollector(
      new Map<string, ToolKind>([[toolName, "tool"]]),
    );
    const prompts: unknown[] = [];
    let round = 0;
    const model = new MockLanguageModelV4({
      doGenerate: (async ({ prompt }: { prompt: unknown }) => {
        prompts.push(prompt);
        round += 1;
        return round === 1
          ? {
              content: [
                {
                  type: "tool-call" as const,
                  toolCallId: "call-1",
                  toolName,
                  input: "{}",
                },
              ],
              finishReason: "tool-calls" as const,
              usage: usage(20, 8),
              warnings: [],
            }
          : {
              content: [{ type: "text" as const, text: "handled it" }],
              finishReason: "stop" as const,
              usage: usage(10, 5),
              warnings: [],
            };
      }) as never,
    });
    const runtime = new ToolLoopAgent({
      model,
      instructions: "test",
      tools: toolset,
      stopWhen: stepCountIs(5),
      ...collector.callbacks,
    });
    return { generate: runtime.generate({ prompt: "go" }), collector, prompts };
  };

  const httpToolset = async () => {
    stubHttpRows([
      {
        name: "call_api",
        description: "d",
        endpoint: "http://api",
        inputSchema: { type: "object" },
        needsApproval: false,
      },
    ]);
    const { tools } = await loadHttpTools("agent");
    return tools;
  };

  const mcpToolset = async (execute: () => Promise<unknown>) => {
    vi.mocked(loadMcpServers).mockResolvedValue([
      {
        id: "c1",
        name: "Server",
        serverUrl: "http://x",
        authConfig: null,
        approvalToolNames: [],
        toolNames: ["search"],
      },
    ]);
    vi.mocked(createMCPClient).mockResolvedValue({
      tools: vi.fn().mockResolvedValue({
        search: { description: "s", inputSchema: jsonSchema({}), execute },
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof createMCPClient>>);
    const { tools } = await loadMcpTools("agent");
    return tools;
  };

  it("an HTTP non-2xx: recorded error, and the loop continues with the detail in the model's context", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "boom internal",
      } as Response),
    );

    const { generate, collector, prompts } = runOneToolCall(
      await httpToolset(),
      "call_api",
    );
    const result = await generate;

    expect(result.text).toBe("handled it");
    expect(collector.snapshot().calls).toEqual([
      {
        kind: "tool",
        name: "call_api",
        durationMs: expect.any(Number),
        status: "error",
      },
    ]);
    expect(JSON.stringify(prompts.at(-1))).toContain("HTTP 500: boom internal");
    vi.unstubAllGlobals();
  });

  it("an HTTP timeout: recorded error, not ok", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url, opts) => {
        const signal = (opts as { signal: AbortSignal }).signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }),
    );

    const { generate, collector, prompts } = runOneToolCall(
      await httpToolset(),
      "call_api",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await generate;

    expect(collector.snapshot().calls).toEqual([
      {
        kind: "tool",
        name: "call_api",
        durationMs: expect.any(Number),
        status: "error",
      },
    ]);
    expect(JSON.stringify(prompts.at(-1))).toContain("did not respond within");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("an MCP tool call timeout: recorded error, not ok", async () => {
    vi.useFakeTimers();
    const toolset = await mcpToolset(() => new Promise(() => {}));

    const { generate, collector, prompts } = runOneToolCall(
      toolset,
      "Server__search",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await generate;

    expect(collector.snapshot().calls).toEqual([
      {
        kind: "tool",
        name: "Server__search",
        durationMs: expect.any(Number),
        status: "error",
      },
    ]);
    expect(JSON.stringify(prompts.at(-1))).toContain("MCP tool call timed out");
    vi.useRealTimers();
  });
});

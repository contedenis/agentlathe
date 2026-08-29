import {
  agentTools,
  db,
  httpToolName,
  mcpToolName,
  subAgentToolName,
  tools,
} from "@agentlathe/db";
import {
  createMCPClient,
  type ListToolsResult,
  type MCPClient,
} from "@ai-sdk/mcp";
import { type JSONSchema7, jsonSchema, type ToolSet, tool } from "ai";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type ApprovalStrategy, buildHeadlessToolApproval } from "./approval";
import { MAX_DEPTH, type RuntimeCtx } from "./context";
import { addTool, addToolWithApproval, buildAuth } from "./helpers";
import { compileInputSchema, describeSchemaErrors } from "./input-schema";
import { loadMcpServers, loadSubAgents, type McpServerGroup } from "./loaders";
import type { AgentRunStats } from "./recording";

export type ToolKind = "tool" | "mcp" | "sub_agent" | "skill";

const MAX_TOOL_RESPONSE_BYTES = 256 * 1024;
const TRUNCATION_SUFFIX = "[truncated]";
const HTTP_TOOL_TIMEOUT_MS = 30_000;

async function readCappedText(
  res: Response,
  maxBytes: number,
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();

  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.length > maxBytes) {
      text += decoder.decode(value.subarray(0, maxBytes - received), {
        stream: true,
      });
      truncated = true;
      await reader.cancel();
      break;
    }
    text += decoder.decode(value, { stream: true });
    received += value.length;
  }
  text += decoder.decode();
  return truncated ? `${text}${TRUNCATION_SUFFIX}` : text;
}

export async function loadHttpTools(
  agentId: string,
): Promise<{ tools: ToolSet; approvalToolNames: Set<string> }> {
  const rows = await db
    .select({
      name: tools.name,
      description: tools.description,
      endpoint: tools.endpoint,
      inputSchema: tools.inputSchema,
      needsApproval: tools.needsApproval,
    })
    .from(agentTools)
    .innerJoin(tools, eq(agentTools.toolId, tools.id))
    .where(and(eq(agentTools.agentId, agentId), eq(tools.isActive, true)));

  const result: ToolSet = {};
  const approvalToolNames = new Set<string>();
  for (const row of rows) {
    const validateInput = compileInputSchema(row.inputSchema);
    if (!validateInput)
      console.warn(
        `Tool "${row.name}" has an invalid input schema; its inputs are not validated.`,
      );
    // Providers reject names outside [a-zA-Z0-9_-]; the UI keeps the original.
    const name = addTool(
      result,
      httpToolName(row.name),
      tool({
        description: row.description,
        inputSchema: jsonSchema(
          row.inputSchema as JSONSchema7,
          validateInput
            ? {
                validate: (value) =>
                  validateInput(value)
                    ? { success: true, value }
                    : {
                        success: false,
                        error: new Error(
                          `Input does not match the tool's schema: ${describeSchemaErrors(validateInput)}`,
                        ),
                      },
              }
            : undefined,
        ),
        execute: async (input, { abortSignal }) => {
          // Own controller, not AbortSignal.timeout: only this flag tells a tool timeout
          // apart from a cancelled run.
          const timeout = new AbortController();
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            timeout.abort();
          }, HTTP_TOOL_TIMEOUT_MS);
          const signal = abortSignal
            ? AbortSignal.any([abortSignal, timeout.signal])
            : timeout.signal;

          let outcome: { res: Response; body: string };
          try {
            const res = await fetch(row.endpoint, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(input),
              signal,
            });
            outcome = {
              res,
              body: await readCappedText(res, MAX_TOOL_RESPONSE_BYTES),
            };
          } catch (err) {
            // A cancelled run is not a tool failure: the caller's abort propagates untouched.
            if (abortSignal?.aborted) throw err;
            // The model sees error.toString(), so these must be real Errors that read
            // well after the "Error: " prefix.
            if (timedOut)
              throw new Error(
                `The tool endpoint did not respond within ${HTTP_TOOL_TIMEOUT_MS / 1000}s.`,
              );
            throw new Error(
              `The tool endpoint could not be reached: ${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            clearTimeout(timer);
          }
          if (!outcome.res.ok)
            throw new Error(`HTTP ${outcome.res.status}: ${outcome.body}`);
          return outcome.body;
        },
      }),
    );
    if (row.needsApproval) approvalToolNames.add(name);
  }
  return { tools: result, approvalToolNames };
}

const MCP_CONNECT_TIMEOUT_MS = 30_000;
const MCP_CALL_TIMEOUT_MS = 60_000;

class McpTimeoutError extends Error {}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new McpTimeoutError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type ToolWithExecute = {
  execute?: (input: unknown, options: unknown) => unknown;
};

function withCallTimeout(toolDef: ToolSet[string]): ToolSet[string] {
  const execute = (toolDef as ToolWithExecute).execute;
  if (!execute) return toolDef;
  return {
    ...toolDef,
    // Thrown, not returned: the model still gets the text and the call records as an error.
    execute: async (input: unknown, options: unknown) =>
      withTimeout(
        Promise.resolve(execute(input, options)),
        MCP_CALL_TIMEOUT_MS,
        "MCP tool call timed out",
      ),
  } as ToolSet[string];
}

function withMcpConnectTimeout<T>(promise: Promise<T>): Promise<T> {
  return withTimeout(
    promise,
    MCP_CONNECT_TIMEOUT_MS,
    "MCP server connection timed out",
  );
}

function connectMcpClient(
  serverUrl: string,
  authConfig: unknown,
): Promise<MCPClient> {
  return withMcpConnectTimeout(
    createMCPClient({
      transport: {
        type: "http",
        url: serverUrl,
        headers: buildAuth(authConfig),
      },
    }),
  );
}

async function withMcpClient<T>(
  serverUrl: string,
  authConfig: unknown,
  fn: (client: MCPClient) => Promise<T>,
): Promise<T> {
  const client = await connectMcpClient(serverUrl, authConfig);
  try {
    return await withMcpConnectTimeout(fn(client));
  } finally {
    await client.close();
  }
}

// Returns the client open: the tools execute through it; the runtime closes it in cleanup.
async function connectMcp(conn: McpServerGroup): Promise<{
  tools: ToolSet;
  approvalNames: Set<string>;
  client: MCPClient;
  missing: string[];
}> {
  const client = await connectMcpClient(conn.serverUrl, conn.authConfig);
  try {
    const available = await withMcpConnectTimeout(client.tools());
    const selected: ToolSet = {};
    const approvalNames = new Set<string>();
    const missing: string[] = [];
    for (const name of conn.toolNames) {
      const mcpTool = available[name];
      if (!mcpTool) {
        missing.push(name);
        continue;
      }
      const finalName = mcpToolName(conn.name, name);
      selected[finalName] = withCallTimeout(mcpTool);
      if (conn.approvalToolNames.includes(name)) approvalNames.add(finalName);
    }
    return { tools: selected, approvalNames, client, missing };
  } catch (err) {
    await client.close();
    throw err;
  }
}

export async function discoverMcpTools(server: {
  serverUrl: string;
  authConfig: unknown;
}): Promise<ListToolsResult["tools"]> {
  return withMcpClient(server.serverUrl, server.authConfig, async (client) => {
    const result = await client.listTools();
    return result.tools;
  });
}

export async function loadMcpTools(agentId: string): Promise<{
  tools: ToolSet;
  approvalToolNames: Set<string>;
  failed: string[];
  clients: MCPClient[];
}> {
  const servers = await loadMcpServers(agentId);
  const settled = await Promise.allSettled(servers.map(connectMcp));

  const merged: ToolSet = {};
  const approvalToolNames = new Set<string>();
  const failed: string[] = [];
  const clients: MCPClient[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") {
      for (const [name, toolDef] of Object.entries(outcome.value.tools))
        addToolWithApproval(
          merged,
          name,
          toolDef,
          outcome.value.approvalNames,
          approvalToolNames,
        );
      clients.push(outcome.value.client);
      // A tool the server stopped offering degrades the run like a dead server: same channel.
      if (outcome.value.missing.length > 0)
        failed.push(
          `${servers[i].name} (tools no longer offered: ${outcome.value.missing.join(", ")})`,
        );
    } else {
      failed.push(servers[i].name);
    }
  });
  return { tools: merged, approvalToolNames, failed, clients };
}

function makeMcpCleanup(clients: MCPClient[]): () => Promise<void> {
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await Promise.allSettled(clients.map((client) => client.close()));
  };
}

// Injected, not imported: runtime.ts already imports tools.ts, so the reverse would cycle.
export type BuildSubAgentRuntime = (
  agentId: string,
  ctx: RuntimeCtx,
  options: { buildApproval: ApprovalStrategy },
) => Promise<{
  agent: {
    generate: (options: {
      prompt: string;
      abortSignal?: AbortSignal;
    }) => Promise<{ text: string }>;
  };
  cleanup: () => Promise<void>;
  stats: () => AgentRunStats;
}>;

export async function buildSubAgentTools(
  parentId: string,
  ctx: RuntimeCtx,
  buildSubAgentRuntime: BuildSubAgentRuntime,
  onChildStats?: (stats: AgentRunStats) => void,
): Promise<ToolSet> {
  const children = await loadSubAgents(parentId);
  const result: ToolSet = {};
  for (const child of children) {
    const childId = child.id;
    const subAgentTool = tool({
      description: child.description ?? child.name,
      inputSchema: z.object({
        task: z.string().describe("Task for the sub-agent"),
      }),
      execute: async ({ task }, { abortSignal }) => {
        if (ctx.callStack.has(childId))
          return "Error: sub-agent cycle detected.";
        if (ctx.depth >= MAX_DEPTH)
          return "Error: maximum sub-agent depth exceeded.";
        if (ctx.subAgentBudget.remaining <= 0)
          return "Error: sub-agent call budget for this run is exhausted.";
        ctx.subAgentBudget.remaining -= 1;

        const childCtx: RuntimeCtx = {
          callStack: new Set(ctx.callStack).add(childId),
          depth: ctx.depth + 1,
          subAgentBudget: ctx.subAgentBudget,
        };
        const { agent, cleanup, stats } = await buildSubAgentRuntime(
          childId,
          childCtx,
          { buildApproval: buildHeadlessToolApproval },
        );
        try {
          const output = await agent.generate({ prompt: task, abortSignal });
          return output.text;
        } finally {
          await cleanup();
          onChildStats?.(stats());
        }
      },
    });
    addTool(result, subAgentToolName(child.slug), subAgentTool);
  }
  return result;
}

export async function buildTools(
  agentId: string,
  ctx: RuntimeCtx,
  buildSubAgentRuntime: BuildSubAgentRuntime,
  onChildStats?: (stats: AgentRunStats) => void,
): Promise<{
  tools: ToolSet;
  approvalToolNames: Set<string>;
  toolKinds: Map<string, ToolKind>;
  mcpFailures: string[];
  cleanup: () => Promise<void>;
}> {
  const [httpOutcome, mcpOutcome, subAgentOutcome] = await Promise.allSettled([
    loadHttpTools(agentId),
    loadMcpTools(agentId),
    buildSubAgentTools(agentId, ctx, buildSubAgentRuntime, onChildStats),
  ]);
  // A sibling failure must not leak the MCP clients that already connected.
  if (
    httpOutcome.status !== "fulfilled" ||
    mcpOutcome.status !== "fulfilled" ||
    subAgentOutcome.status !== "fulfilled"
  ) {
    if (mcpOutcome.status === "fulfilled")
      await makeMcpCleanup(mcpOutcome.value.clients)();
    const rejected = [httpOutcome, mcpOutcome, subAgentOutcome].find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    throw rejected?.reason;
  }
  const http = httpOutcome.value;
  const mcp = mcpOutcome.value;
  const subAgentTools = subAgentOutcome.value;
  const merged: ToolSet = {};
  const toolKinds = new Map<string, ToolKind>();
  const approvalToolNames = new Set<string>();
  const sources: Array<[ToolSet, ToolKind, Set<string>]> = [
    [http.tools, "tool", http.approvalToolNames],
    [mcp.tools, "mcp", mcp.approvalToolNames],
    [subAgentTools, "sub_agent", new Set()],
  ];
  for (const [source, kind, needsApproval] of sources)
    for (const [name, toolDef] of Object.entries(source)) {
      const finalName = addToolWithApproval(
        merged,
        name,
        toolDef,
        needsApproval,
        approvalToolNames,
      );
      toolKinds.set(finalName, kind);
    }

  if (mcp.failed.length > 0)
    console.warn(
      `MCP tools unavailable for this run: ${mcp.failed.join(", ")}`,
    );

  return {
    tools: merged,
    approvalToolNames,
    toolKinds,
    mcpFailures: mcp.failed,
    cleanup: makeMcpCleanup(mcp.clients),
  };
}

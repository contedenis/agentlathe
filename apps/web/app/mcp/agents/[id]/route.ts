import { agentAskToolName } from "@agentlathe/db";
import {
  type AgentProgress,
  type AgentRow,
  type AgentRunStats,
  generateWithApprovals,
  loadActiveAgent,
  type PendingApproval,
} from "@agentlathe/runner";
import { mcpApprovalBroker as broker } from "@/lib/approval-broker";
import { createRecorder } from "@/lib/run-recorder";

const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18"];
const DEFAULT_PROTOCOL = "2025-11-25";

type JsonRpc = {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

function rpcResult(id: string | number, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function rpcError(id: string | number, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function toolResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function isResponse(message: JsonRpc): boolean {
  return (
    message.id !== undefined &&
    message.method === undefined &&
    ("result" in message || "error" in message)
  );
}

function describeTool(agent: AgentRow) {
  return {
    name: agentAskToolName(agent.slug),
    description:
      agent.description ??
      `Ask the agentlathe agent "${agent.name}". Takes a natural-language message and returns its answer.`,
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The message or question for the agent.",
        },
      },
      required: ["message"],
    },
  };
}

function streamAgentCall(
  clientRequestId: string | number,
  agent: AgentRow,
  message: string,
  {
    canElicit,
    progressToken,
    signal,
  }: { canElicit: boolean; progressToken?: unknown; signal: AbortSignal },
) {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  if (signal.aborted) abort.abort();
  else signal.addEventListener("abort", () => abort.abort(), { once: true });

  const stream = new ReadableStream({
    async start(controller) {
      // After a client disconnect enqueue throws; the run outcome still gets recorded.
      const send = (payload: object) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
          );
        } catch {}
      };

      const onProgress =
        progressToken === undefined
          ? undefined
          : (progress: AgentProgress) =>
              send({
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: progress.step,
                  message: progress.label,
                },
              });

      const askApproval = (pending: PendingApproval) =>
        broker.ask((requestId) => {
          send({
            jsonrpc: "2.0",
            id: requestId,
            method: "elicitation/create",
            params: {
              message: `The agent "${agent.name}" wants to run the tool \`${pending.toolName}\` with: ${JSON.stringify(pending.input)}`,
              requestedSchema: {
                type: "object",
                properties: {
                  approve: {
                    type: "boolean",
                    title: "Approve",
                    description: "Allow the agent to run this tool.",
                  },
                },
                required: ["approve"],
              },
            },
          });
        });

      const recorder = createRecorder({ agent, source: "mcp" });
      let stats: AgentRunStats | undefined;
      try {
        const { text } = await generateWithApprovals(agent, message, {
          askApproval: canElicit ? askApproval : undefined,
          onProgress,
          abortSignal: abort.signal,
          onStats: (runStats) => {
            stats = runStats;
          },
        });
        await recorder.record({ stats });
        await recorder.attachTranscript(
          [{ role: "user", content: message }],
          [{ role: "assistant", content: text }],
        );
        send(rpcResult(clientRequestId, toolResult(text)));
      } catch (err) {
        console.error(err);
        await recorder.record({ stats, error: err });
        await recorder.attachTranscript(
          [{ role: "user", content: message }],
          [],
        );
        send(
          rpcResult(
            clientRequestId,
            toolResult(
              `The agent failed: ${err instanceof Error ? err.message : "unknown error"}`,
              true,
            ),
          ),
        );
      }
      try {
        controller.close();
      } catch {}
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function handleSync(
  message: JsonRpc,
  agent: AgentRow,
  sessionId: string,
): object | null {
  const { method, id, params } = message;
  if (id === undefined) return null;

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOLS.includes(requested)
          ? requested
          : DEFAULT_PROTOCOL;
      const capabilities = params?.capabilities as
        | Record<string, unknown>
        | undefined;
      broker.rememberSession(
        sessionId,
        capabilities?.elicitation !== undefined,
      );

      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: `agentlathe/${agent.name}`, version: "1.0.0" },
      });
    }

    case "tools/list":
      return rpcResult(id, { tools: [describeTool(agent)] });

    case "ping":
      return rpcResult(id, {});

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let idOrName = id;
  try {
    idOrName = decodeURIComponent(id);
  } catch {}

  const agent = await loadActiveAgent(idOrName);
  if (!agent)
    return Response.json(
      { error: "Agent not found or inactive." },
      { status: 404 },
    );

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }

  // Neither supported protocol version batches, so an array is as invalid as a string.
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      },
      { status: 400 },
    );

  const sessionId = req.headers.get("mcp-session-id") ?? crypto.randomUUID();
  const message = body as JsonRpc;

  if (isResponse(message)) {
    const result = message.result as
      | { action?: string; content?: { approve?: boolean } }
      | undefined;
    broker.resolve(
      String(message.id),
      result?.action === "accept" && result.content?.approve === true,
    );
    return new Response(null, { status: 202 });
  }

  if (message.method === "tools/call" && message.id !== undefined) {
    const name = message.params?.name;
    if (name !== agentAskToolName(agent.slug))
      return Response.json(
        rpcError(message.id, -32602, `Unknown tool: ${String(name)}`),
      );

    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
    if (typeof args.message !== "string" || args.message.trim() === "")
      return Response.json(
        rpcError(message.id, -32602, "The 'message' field is required."),
      );

    return streamAgentCall(message.id, agent, args.message, {
      canElicit: broker.canElicit(sessionId),
      progressToken: (
        message.params?._meta as Record<string, unknown> | undefined
      )?.progressToken,
      signal: req.signal,
    });
  }

  const reply = handleSync(message, agent, sessionId);
  if (reply === null) return new Response(null, { status: 202 });

  return Response.json(reply, {
    headers: { "mcp-session-id": sessionId },
  });
}

export function GET() {
  return new Response("Method Not Allowed", { status: 405 });
}

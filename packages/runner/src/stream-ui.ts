import {
  createAgentUIStream,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type InferUIMessageChunk,
  type UIMessage,
} from "ai";
import { buildDashboardToolApproval } from "./approval";
import type { AgentRow } from "./loaders";
import { type AgentRunStats, deniedApprovalCalls } from "./recording";
import { buildAgentRuntime } from "./runtime";

export type AgentUIMessage = UIMessage<unknown, { run: { runId: string } }>;

type AgentUIMessageChunk = InferUIMessageChunk<AgentUIMessage>;

export async function streamAgentForUI(
  agent: AgentRow,
  messages: UIMessage[],
  options: {
    onTranscript?: (
      input: UIMessage[],
      output: UIMessage[],
    ) => PromiseLike<void> | void;
    abortSignal?: AbortSignal;
    onRunEnd?: (run: {
      stats: AgentRunStats;
      durationMs: number;
      error?: unknown;
    }) => Promise<string | null>;
  } = {},
): Promise<Response> {
  const { onTranscript, abortSignal, onRunEnd } = options;
  const {
    agent: runtime,
    cleanup,
    stats,
    toolKinds,
  } = await buildAgentRuntime(agent, {
    buildApproval: buildDashboardToolApproval,
  });

  try {
    const inputDenials = deniedApprovalCalls(messages, toolKinds);
    const startedAt = Date.now();
    let streamError: unknown;
    const toolErrors = new Set<unknown>();
    // The run row exists only after the turn ends, mid-stream: it cannot travel in a header.
    let resolveRunId: (id: string | null) => void = () => {};
    const runId = new Promise<string | null>((resolve) => {
      resolveRunId = resolve;
    });
    abortSignal?.addEventListener("abort", () => resolveRunId(null), {
      once: true,
    });

    const agentStream = await createAgentUIStream({
      agent: runtime,
      uiMessages: messages,
      abortSignal,
      // Without this the transcript stops sharing ids with the chat and an annotation
      // can no longer anchor to the stored turn.
      generateMessageId: () => crypto.randomUUID(),
      onEnd: async (event) => {
        try {
          await cleanup();
          const turnStats = stats();
          const recorded = await onRunEnd?.({
            stats: {
              ...turnStats,
              calls: [...turnStats.calls, ...inputDenials],
            },
            durationMs: Date.now() - startedAt,
            error: streamError,
          });
          resolveRunId(typeof recorded === "string" ? recorded : null);
          // An approval continuation extends the last request message in place: it is this run's output.
          const kept = event.isContinuation
            ? messages.length - 1
            : messages.length;
          await onTranscript?.(
            messages.slice(0, kept),
            event.messages.slice(kept),
          );
        } finally {
          resolveRunId(null);
        }
      },
      experimental_transform: () =>
        new TransformStream({
          transform(part, controller) {
            if (part.type === "tool-error") toolErrors.add(part.error);
            else if (part.type === "tool-call" && part.invalid)
              toolErrors.add(part.error);
            controller.enqueue(part);
          },
        }),
      // Runs before onEnd, so a failed turn is never recorded as healthy. The SDK calls
      // this twice — real error, then masked text — so ??= keeps the one worth reviewing.
      // Tool errors pass through here too; the loop recovers from them, so they keep
      // their text and fail nothing.
      onError: (error) => {
        if (toolErrors.has(error))
          return error instanceof Error ? error.message : String(error);
        streamError ??= error;
        void cleanup();
        return "An error occurred.";
      },
    });

    const stream = createUIMessageStream<AgentUIMessage>({
      execute: async ({ writer }) => {
        writer.merge(agentStream as ReadableStream<AgentUIMessageChunk>);
        const id = await runId;
        if (id) writer.write({ type: "data-run", data: { runId: id } });
      },
      onError: () => "An error occurred.",
    });

    return createUIMessageStreamResponse({ stream });
  } catch (err) {
    // Everything above is setup before the stream — and its onEnd/onError — exists, so a
    // throw here would leave the MCP clients from buildAgentRuntime open.
    await cleanup();
    throw err;
  }
}

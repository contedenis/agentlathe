import type { ModelMessage } from "ai";
import {
  type ApprovalStrategy,
  buildDashboardToolApproval,
  buildHeadlessToolApproval,
} from "./approval";
import type { AgentRow } from "./loaders";
import { type AgentRunStats, describeCall } from "./recording";
import { buildAgentRuntime } from "./runtime";

export type PendingApproval = {
  approvalId: string;
  toolName: string;
  input: unknown;
};

export type AgentProgress = {
  step: number;
  label: string;
};

export async function generateWithApprovals(
  agent: AgentRow,
  message: string,
  options: {
    askApproval?: (pending: PendingApproval) => Promise<boolean>;
    headlessApproval?: ApprovalStrategy;
    onProgress?: (progress: AgentProgress) => void;
    maxRounds?: number;
    abortSignal?: AbortSignal;
    onStats?: (stats: AgentRunStats) => void;
  } = {},
): Promise<{ text: string; stats: AgentRunStats }> {
  const {
    askApproval,
    headlessApproval = buildHeadlessToolApproval,
    onProgress,
    maxRounds = 8,
    abortSignal,
    onStats,
  } = options;
  const buildApproval = askApproval
    ? buildDashboardToolApproval
    : headlessApproval;

  const maxSteps = agent.maxSteps ?? 20;
  let stepsUsed = 0;
  // One runtime for the whole run: MCP connects once and maxSteps caps the run, not a round.
  const {
    agent: runtime,
    cleanup,
    stats,
    ownSteps,
    toolKinds,
  } = await buildAgentRuntime(agent, {
    buildApproval,
    stopWhen: ({ steps }) => stepsUsed + steps.length >= maxSteps,
  });

  let messages: ModelMessage[] = [{ role: "user", content: message }];
  const denied = new Set<string>();
  const deniedCalls: AgentRunStats["calls"] = [];
  let approvalsGranted = 0;
  let step = 0;
  const report = (label: string) => onProgress?.({ step: ++step, label });

  const finalStats = (): AgentRunStats => {
    const snapshot = stats();
    return {
      ...snapshot,
      approvalsGranted: snapshot.approvalsGranted + approvalsGranted,
      calls: [...snapshot.calls, ...deniedCalls],
    };
  };

  try {
    for (let round = 0; round < maxRounds; round++) {
      abortSignal?.throwIfAborted();
      const result = await runtime.generate({
        messages,
        abortSignal,
        onToolExecutionStart: ({ toolCall }) =>
          report(`Executing ${toolCall.toolName}`),
      });
      stepsUsed = ownSteps();

      const requests = result.content
        .filter((part) => part.type === "tool-approval-request")
        .filter((part) => !part.isAutomatic);
      if (requests.length === 0)
        return { text: result.text, stats: finalStats() };

      const decisions = await Promise.all(
        requests.map(async (request) => {
          const { toolName, input } = request.toolCall;
          const alreadyDenied = denied.has(toolName);
          if (!alreadyDenied) report(`Awaiting approval for ${toolName}`);
          const approved =
            !alreadyDenied &&
            askApproval !== undefined &&
            (await askApproval({
              approvalId: request.approvalId,
              toolName,
              input,
            }));
          if (approved) approvalsGranted += 1;
          else {
            denied.add(toolName);
            // A denial resolved via injected messages never surfaces as a step part.
            deniedCalls.push({
              ...describeCall(toolName, input, toolKinds),
              status: "denied",
            });
          }
          return {
            type: "tool-approval-response" as const,
            approvalId: request.approvalId,
            approved,
          };
        }),
      );

      messages = [
        ...messages,
        ...result.response.messages,
        { role: "tool", content: decisions } as ModelMessage,
      ];
    }
  } finally {
    await cleanup();
    // The only exit for a caller that must record a failed run: throwing paths never return.
    onStats?.(finalStats());
  }

  throw new Error(
    `The agent exceeded ${maxRounds} approval rounds without finishing.`,
  );
}

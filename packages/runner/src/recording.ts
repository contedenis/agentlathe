import {
  type AgentRunSource,
  getSettings,
  isTrackingEnabled,
  recordAgentRun,
  saveRunTranscript,
} from "@agentlathe/db";
import {
  getToolOrDynamicToolName,
  isDynamicToolUIPart,
  isToolUIPart,
  type ToolLoopAgentSettings,
  type ToolSet,
  type UIMessage,
} from "ai";
import type { AgentRow } from "./loaders";
import type { ToolKind } from "./tools";
import { resolveAgentVersion } from "./versions";

export type AgentRunCallRecord = {
  kind: ToolKind;
  name: string;
  durationMs?: number | null;
  status?: "ok" | "error" | "denied";
};

export type AgentRunStats = {
  steps: number;
  toolCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  approvalsRequested: number;
  approvalsGranted: number;
  calls: AgentRunCallRecord[];
  mcpFailures: string[];
};

export function emptyRunStats(): AgentRunStats {
  return {
    steps: 0,
    toolCalls: 0,
    inputTokens: null,
    outputTokens: null,
    approvalsRequested: 0,
    approvalsGranted: 0,
    calls: [],
    mcpFailures: [],
  };
}

// Folds a sub-agent's consumption into its parent. Calls and approvals stay the
// parent's own: the sub_agent call row already represents the delegation.
export function addChildRunStats(
  target: AgentRunStats,
  child: AgentRunStats,
): void {
  target.steps += child.steps;
  target.toolCalls += child.toolCalls;
  if (child.inputTokens !== null)
    target.inputTokens = (target.inputTokens ?? 0) + child.inputTokens;
  if (child.outputTokens !== null)
    target.outputTokens = (target.outputTokens ?? 0) + child.outputTokens;
  target.mcpFailures.push(...child.mcpFailures);
}

export function describeCall(
  toolName: string,
  input: unknown,
  toolKinds: Map<string, ToolKind>,
): { kind: ToolKind; name: string } {
  const kind = toolKinds.get(toolName) ?? "tool";
  if (kind !== "skill") return { kind, name: toolName };
  const skillName = (input as { name?: unknown } | undefined)?.name;
  return {
    kind: "skill",
    name: typeof skillName === "string" ? skillName : toolName,
  };
}

type ToolExecutionEndEvent = {
  toolCall: { toolName: string; input: unknown };
  toolOutput: { type: string };
  toolExecutionMs: number;
};

type StepEndEvent = {
  usage: { inputTokens?: number; outputTokens?: number };
  content: Array<{
    type: string;
    toolName?: string;
    toolCallId?: string;
    isAutomatic?: boolean;
    approved?: boolean;
    output?: { type?: string };
    toolCall?: { toolCallId: string; toolName: string; input?: unknown };
  }>;
};

export function createRunStatsCollector(toolKinds: Map<string, ToolKind>) {
  const stats = emptyRunStats();
  const deniedCallIds = new Set<string>();

  const recordDenied = (callId: string, toolName: string, input: unknown) => {
    if (deniedCallIds.has(callId)) return;
    deniedCallIds.add(callId);
    stats.calls.push({
      ...describeCall(toolName, input, toolKinds),
      status: "denied",
    });
  };

  const onToolExecutionEnd = (event: ToolExecutionEndEvent) => {
    stats.toolCalls += 1;
    stats.calls.push({
      ...describeCall(event.toolCall.toolName, event.toolCall.input, toolKinds),
      durationMs: event.toolExecutionMs,
      status: event.toolOutput.type === "tool-error" ? "error" : "ok",
    });
  };

  const onStepEnd = (step: StepEndEvent) => {
    stats.steps += 1;
    if (step.usage.inputTokens !== undefined)
      stats.inputTokens = (stats.inputTokens ?? 0) + step.usage.inputTokens;
    if (step.usage.outputTokens !== undefined)
      stats.outputTokens = (stats.outputTokens ?? 0) + step.usage.outputTokens;
    for (const part of step.content) {
      if (part.type === "tool-approval-request" && !part.isAutomatic)
        stats.approvalsRequested += 1;
      // A denial never executes, so onToolExecutionEnd cannot see it. Below are the two
      // shapes the SDK emits (pinned in the .sdk tests).
      if (
        part.type === "tool-approval-response" &&
        part.approved === false &&
        part.toolCall
      )
        recordDenied(
          part.toolCall.toolCallId,
          part.toolCall.toolName,
          part.toolCall.input,
        );
      if (
        part.type === "tool-result" &&
        part.output?.type === "execution-denied" &&
        part.toolName
      )
        recordDenied(
          part.toolCallId ?? part.toolName,
          part.toolName,
          undefined,
        );
    }
  };

  return {
    callbacks: { onToolExecutionEnd, onStepEnd } as Pick<
      ToolLoopAgentSettings<never, ToolSet>,
      "onToolExecutionEnd" | "onStepEnd"
    >,
    snapshot: (): AgentRunStats => ({ ...stats, calls: [...stats.calls] }),
  };
}

// A Playground denial arrives in the NEXT turn's input and emits no step part.
export function deniedApprovalCalls(
  messages: UIMessage[],
  toolKinds: Map<string, ToolKind>,
): AgentRunCallRecord[] {
  const seen = new Set<string>();
  const denied: AgentRunCallRecord[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (!isToolUIPart(part) && !isDynamicToolUIPart(part)) continue;
      if (part.state !== "approval-responded") continue;
      if (part.approval?.approved !== false) continue;
      if (seen.has(part.toolCallId)) continue;
      seen.add(part.toolCallId);
      denied.push({
        ...describeCall(getToolOrDynamicToolName(part), part.input, toolKinds),
        status: "denied",
      });
    }
  }
  return denied;
}

export type RunRecorder = {
  record: (outcome: {
    stats?: AgentRunStats;
    durationMs?: number;
    error?: unknown;
  }) => Promise<string | null>;
  attachTranscript: (input: unknown, output: unknown) => Promise<void>;
  runId: () => string | null;
};

export type RunRecorderOptions = {
  agent: AgentRow;
  source: AgentRunSource;
  threadId?: string | null;
  onTranscriptSaved?: (runId: string) => void;
};

export function createRunRecorder(run: RunRecorderOptions): RunRecorder {
  const { agent, source, threadId = null, onTranscriptSaved } = run;
  const startedAt = Date.now();
  let recorded: string | null = null;
  const version = getSettings()
    .then((appSettings) =>
      isTrackingEnabled(source, appSettings)
        ? resolveAgentVersion(agent.id)
        : null,
    )
    .catch((err) => {
      console.error("resolveAgentVersion failed", err);
      return null;
    });

  return {
    record: async ({ stats, durationMs, error }) => {
      const elapsedMs = durationMs ?? Date.now() - startedAt;
      recorded = await recordAgentRun({
        agentId: agent.id,
        agentVersionId: await version,
        source,
        threadId,
        model: agent.model,
        durationMs: elapsedMs,
        ...(stats ?? {}),
        status: error ? "error" : "ok",
        error: error
          ? error instanceof Error
            ? error.message
            : String(error)
          : null,
      });
      return recorded;
    },
    attachTranscript: async (input, output) => {
      if (!recorded) return;
      if (source !== "dashboard" && !agent.recordTraffic) return;
      const runId = recorded;
      if (!(await saveRunTranscript(runId, input, output))) return;
      try {
        onTranscriptSaved?.(runId);
      } catch (err) {
        console.error("onTranscriptSaved failed", err);
      }
    },
    runId: () => recorded,
  };
}

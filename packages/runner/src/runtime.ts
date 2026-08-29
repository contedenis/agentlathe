import {
  type PrepareStepFunction,
  pruneMessages,
  type StopCondition,
  stepCountIs,
  type Tool,
  ToolLoopAgent,
  type ToolSet,
  tool,
} from "ai";
import { z } from "zod";
import type { ApprovalStrategy } from "./approval";
import { MAX_SUB_AGENT_CALLS, type RuntimeCtx } from "./context";
import {
  addTool,
  buildProvider,
  estimateTokens,
  getContextLimit,
} from "./helpers";
import {
  type AgentRow,
  loadAgentConfig,
  loadSkills,
  type SkillRow,
} from "./loaders";
import {
  type AgentRunStats,
  addChildRunStats,
  createRunStatsCollector,
} from "./recording";
import { buildTools } from "./tools";

export function buildSystemPrompt(agent: AgentRow, skills: SkillRow[]): string {
  const base = agent.systemPrompt ?? "";
  if (skills.length === 0) return base;
  const listed = skills
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n");
  return `${base}\n\n## Available skills\nUse the \`load_skill\` tool with the skill name to load its full content.\n${listed}`;
}

export function buildLoadSkillTool(skills: SkillRow[]): Tool {
  return tool({
    description: "Loads the full content of a skill by name.",
    inputSchema: z.object({
      name: z.string().describe("Name of the skill to load"),
    }),
    execute: async ({ name }) => {
      const skill = skills.find((candidate) => candidate.name === name);
      return skill ? skill.content : `Error: skill '${name}' not found.`;
    },
  });
}

export function buildPrepareStep(
  agent: AgentRow,
): PrepareStepFunction<ToolSet> {
  return async ({ messages }) => {
    const limit = await getContextLimit(agent.model);
    if (estimateTokens(messages) > limit * 0.8) {
      return {
        messages: pruneMessages({
          messages,
          toolCalls: "before-last-3-messages",
        }),
      };
    }
    return {};
  };
}

type RuntimeOptions = {
  buildApproval?: ApprovalStrategy;
  stopWhen?: StopCondition<ToolSet>;
};

export async function buildAgentRuntime(
  agent: AgentRow,
  options?: RuntimeOptions,
) {
  return assembleRuntime(
    agent,
    {
      callStack: new Set([agent.id]),
      depth: 0,
      subAgentBudget: { remaining: MAX_SUB_AGENT_CALLS },
    },
    options,
  );
}

export async function buildSubAgentRuntime(
  agentId: string,
  ctx: RuntimeCtx,
  options?: RuntimeOptions,
) {
  return assembleRuntime(await loadAgentConfig(agentId), ctx, options);
}

async function assembleRuntime(
  agent: AgentRow,
  ctx: RuntimeCtx,
  options?: RuntimeOptions,
) {
  const childRunStats: AgentRunStats[] = [];
  const [skillsOutcome, composedOutcome] = await Promise.allSettled([
    loadSkills(agent.id),
    buildTools(agent.id, ctx, buildSubAgentRuntime, (childStats) =>
      childRunStats.push(childStats),
    ),
  ]);
  if (composedOutcome.status === "rejected") throw composedOutcome.reason;
  const composed = composedOutcome.value;
  // Once buildTools resolved, every exit path owns live MCP clients to close.
  if (skillsOutcome.status === "rejected") {
    await composed.cleanup();
    throw skillsOutcome.reason;
  }
  const skills = skillsOutcome.value;

  const conflicting = composed.tools.load_skill;
  const toolset: ToolSet = {
    ...composed.tools,
    load_skill: buildLoadSkillTool(skills),
  };
  const toolKinds = new Map(composed.toolKinds);
  const approvalToolNames = new Set(composed.approvalToolNames);
  if (conflicting) {
    // The renamed tool keeps its kind and its approval gate under the new name.
    const finalName = addTool(toolset, "load_skill", conflicting);
    toolKinds.set(finalName, composed.toolKinds.get("load_skill") ?? "tool");
    if (approvalToolNames.delete("load_skill"))
      approvalToolNames.add(finalName);
  }
  toolKinds.set("load_skill", "skill");

  const collector = createRunStatsCollector(toolKinds);

  try {
    const runtime = new ToolLoopAgent({
      model: buildProvider(agent.model),
      instructions: buildSystemPrompt(agent, skills),
      tools: toolset,
      stopWhen: options?.stopWhen ?? stepCountIs(agent.maxSteps ?? 20),
      toolApproval: options?.buildApproval?.(approvalToolNames),
      prepareStep: buildPrepareStep(agent),
      telemetry: { functionId: agent.id },
      ...collector.callbacks,
    });

    return {
      agent: runtime,
      cleanup: composed.cleanup,
      toolKinds,
      // Own steps only: a step cap must mean the same here as in the SDK's stepCountIs.
      ownSteps: (): number => collector.snapshot().steps,
      stats: (): AgentRunStats => {
        const snapshot = collector.snapshot();
        snapshot.mcpFailures = [
          ...composed.mcpFailures,
          ...snapshot.mcpFailures,
        ];
        for (const child of childRunStats) addChildRunStats(snapshot, child);
        return snapshot;
      },
    };
  } catch (err) {
    await composed.cleanup();
    throw err;
  }
}

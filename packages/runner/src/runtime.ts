import { RESERVED_TOOL_NAMES } from "@agentlathe/db";
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
import {
  MAX_SUB_AGENT_CALLS,
  NO_RUN_CONTEXT,
  type RunContext,
  type RuntimeCtx,
} from "./context";
import {
  addTool,
  buildProvider,
  estimateTokens,
  getContextLimit,
} from "./helpers";
import {
  buildSearchKnowledgeTool,
  type KnowledgeView,
  loadKnowledge,
  renderKnowledgeSection,
} from "./knowledge";
import {
  type AgentRow,
  loadAgentConfig,
  loadSkills,
  type SkillRow,
} from "./loaders";
import {
  buildMemoryTools,
  loadMemory,
  type MemoryStoreView,
  renderMemorySection,
} from "./memory";
import {
  type AgentRunStats,
  addChildRunStats,
  createRunStatsCollector,
} from "./recording";
import { buildTools, type ToolKind } from "./tools";

const BUILTIN_KINDS: Record<(typeof RESERVED_TOOL_NAMES)[number], ToolKind> = {
  load_skill: "skill",
  memory_add: "memory",
  memory_update: "memory",
  memory_delete: "memory",
  search_knowledge: "knowledge",
};

export function buildSystemPrompt(
  agent: AgentRow,
  skills: SkillRow[],
  memory: MemoryStoreView[] = [],
  knowledge?: KnowledgeView,
): string {
  const sections = [agent.systemPrompt ?? ""];
  if (skills.length > 0) {
    const listed = skills
      .map((skill) => `- ${skill.name}: ${skill.description}`)
      .join("\n");
    sections.push(
      `## Available skills\nUse the \`load_skill\` tool with the skill name to load its full content.\n${listed}`,
    );
  }
  if (memory.length > 0) sections.push(renderMemorySection(memory));
  const knowledgeSection = knowledge ? renderKnowledgeSection(knowledge) : "";
  if (knowledgeSection) sections.push(knowledgeSection);
  return sections.join("\n\n");
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
  return async ({ messages, instructions }) => {
    const limit = await getContextLimit(agent.model);
    if (estimateTokens([instructions ?? "", messages]) > limit * 0.8) {
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
  run?: RunContext;
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
      run: options?.run ?? NO_RUN_CONTEXT,
      memoryDrafts: new Map(),
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
  const contextLimit = getContextLimit(agent.model);
  const [skillsOutcome, memoryOutcome, knowledgeOutcome, composedOutcome] =
    await Promise.allSettled([
      loadSkills(agent.id),
      loadMemory(agent.id, ctx.run),
      contextLimit.then((limit) => loadKnowledge(agent.id, limit)),
      contextLimit.then((limit) =>
        buildTools(agent.id, limit, ctx, buildSubAgentRuntime, (childStats) =>
          childRunStats.push(childStats),
        ),
      ),
    ]);
  if (composedOutcome.status === "rejected") throw composedOutcome.reason;
  const composed = composedOutcome.value;
  // Once buildTools resolved, every exit path owns live MCP clients to close.
  for (const outcome of [skillsOutcome, memoryOutcome, knowledgeOutcome])
    if (outcome.status === "rejected") {
      await composed.cleanup();
      throw outcome.reason;
    }
  const skills = (skillsOutcome as PromiseFulfilledResult<SkillRow[]>).value;
  const memory = (
    memoryOutcome as PromiseFulfilledResult<
      Awaited<ReturnType<typeof loadMemory>>
    >
  ).value;
  const knowledge = (knowledgeOutcome as PromiseFulfilledResult<KnowledgeView>)
    .value;

  const builtins: Partial<Record<(typeof RESERVED_TOOL_NAMES)[number], Tool>> =
    {
      load_skill: buildLoadSkillTool(skills),
      ...(memory.stores[0]
        ? buildMemoryTools(memory.stores[0], ctx.memoryDrafts)
        : {}),
      ...(knowledge.search.length > 0
        ? { search_knowledge: buildSearchKnowledgeTool(knowledge.search) }
        : {}),
    };
  const toolset: ToolSet = { ...composed.tools };
  const toolKinds = new Map(composed.toolKinds);
  const approvalToolNames = new Set(composed.approvalToolNames);
  for (const name of RESERVED_TOOL_NAMES) {
    const builtin = builtins[name];
    if (!builtin) continue;
    const conflicting = composed.tools[name];
    toolset[name] = builtin;
    if (conflicting) {
      // The renamed tool keeps its kind and its approval gate under the new name.
      const finalName = addTool(toolset, name, conflicting);
      toolKinds.set(finalName, composed.toolKinds.get(name) ?? "tool");
      if (approvalToolNames.delete(name)) approvalToolNames.add(finalName);
    }
    toolKinds.set(name, BUILTIN_KINDS[name]);
  }

  const collector = createRunStatsCollector(toolKinds);

  try {
    const runtime = new ToolLoopAgent({
      model: buildProvider(agent.model),
      instructions: buildSystemPrompt(agent, skills, memory.stores, knowledge),
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
        snapshot.warnings = [
          ...memory.warnings,
          ...knowledge.warnings,
          ...snapshot.warnings,
        ];
        snapshot.memorySeen = [...memory.seen, ...snapshot.memorySeen];
        for (const child of childRunStats) addChildRunStats(snapshot, child);
        snapshot.memoryWrites = [...ctx.memoryDrafts.values()].filter(
          (draft) => draft.ops.length > 0,
        );
        return snapshot;
      },
    };
  } catch (err) {
    await composed.cleanup();
    throw err;
  }
}

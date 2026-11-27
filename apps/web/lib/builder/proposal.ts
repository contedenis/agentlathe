import {
  KNOWLEDGE_MODES,
  SCHEDULE_FREQUENCIES,
} from "@agentlathe/db/constants";
import { z } from "zod";
import type { AgentFormValues } from "@/components/forms/agent-form";
import {
  type AgentMemoryConfig,
  EMPTY_MEMORY_CONFIG,
  MEMORY_TYPES,
  memoryConfigBody,
  memoryConfigError,
} from "@/lib/memory-settings";

export const agentProposalSchema = z.object({
  name: z.string().describe("Unique, human-readable name."),
  slug: z
    .string()
    .optional()
    .describe(
      "Public ID: lowercase letters, digits, dots, underscores and hyphens. Omit to derive it from the name.",
    ),
  description: z.string().describe("One sentence on what the agent is for."),
  model: z.string().describe("A model id returned by search_models."),
  systemPrompt: z.string().describe("The full system prompt."),
  maxSteps: z.number().int().min(1).max(200).optional(),
  skillIds: z.array(z.string()),
  toolIds: z.array(z.string()).describe("Ids of HTTP tools."),
  subAgentIds: z.array(z.string()),
  mcpTools: z.array(
    z.object({
      serverId: z.string(),
      toolName: z
        .string()
        .describe("A tool name returned by list_mcp_tools for that server."),
      needsApproval: z.boolean(),
    }),
  ),
  knowledge: z.array(
    z.object({ collectionId: z.string(), mode: z.enum(KNOWLEDGE_MODES) }),
  ),
  memory: z.object({
    type: z.enum(MEMORY_TYPES),
    purpose: z
      .string()
      .optional()
      .describe("What belongs in the memory. Required unless type is none."),
    requireApproval: z.boolean().optional(),
    memoryKey: z
      .string()
      .optional()
      .describe("Only for type custom: the x-memory-key value callers send."),
  }),
  rationale: z
    .string()
    .describe("Why each piece is there, for the person reviewing it."),
  missing: z
    .array(z.string())
    .describe(
      "What the agent would need that does not exist in this instance yet. Empty when nothing is missing.",
    ),
});

export type AgentProposal = z.infer<typeof agentProposalSchema>;
export type AgentDraft = Partial<Omit<AgentFormValues, "id">>;
export type AgentConfigProposal = Omit<
  AgentProposal,
  "slug" | "missing" | "rationale"
> & { slug?: string };

const unique = <T>(items: T[]): T[] => [
  ...new Map(items.map((item) => [JSON.stringify(item), item])).values(),
];

export function proposalToDraft(
  proposal: AgentConfigProposal,
  current: AgentMemoryConfig = EMPTY_MEMORY_CONFIG,
): AgentDraft {
  const { memory } = proposal;
  return {
    name: proposal.name,
    ...(proposal.slug ? { slug: proposal.slug } : {}),
    description: proposal.description,
    model: proposal.model,
    systemPrompt: proposal.systemPrompt,
    ...(proposal.maxSteps ? { maxSteps: proposal.maxSteps } : {}),
    skillIds: unique(proposal.skillIds),
    toolIds: unique(proposal.toolIds),
    subAgentIds: unique(proposal.subAgentIds),
    mcpTools: unique(proposal.mcpTools),
    knowledge: proposal.knowledge,
    memory:
      memory.type === "none"
        ? { ...current, type: "none" }
        : {
            type: memory.type,
            settings: {
              ...current.settings,
              [memory.type]: {
                purpose:
                  memory.purpose ?? current.settings[memory.type].purpose,
                charLimit: current.settings[memory.type].charLimit,
                requireApproval:
                  memory.requireApproval ??
                  current.settings[memory.type].requireApproval,
              },
            },
            memoryKey: memory.memoryKey ?? current.memoryKey,
          },
  };
}

export function draftBody(draft: AgentDraft) {
  const memory = draft.memory ?? EMPTY_MEMORY_CONFIG;
  const error = memoryConfigError(memory);
  if (error) throw new Error(error);
  return { ...draft, memory: memoryConfigBody(memory) };
}

export const agentChangesSchema = agentProposalSchema
  .omit({ slug: true, missing: true })
  .extend({
    addressedNotes: z
      .array(z.string())
      .describe(
        "Ids of the review notes from get_agent_review that this change answers. Empty when it answers none.",
      ),
  });

export type AgentChanges = z.infer<typeof agentChangesSchema>;

export const skillProposalSchema = z.object({
  name: z.string(),
  description: z
    .string()
    .describe("Always in the agent's prompt: say when to use the skill."),
  content: z.string().describe("The full know-how, loaded on demand."),
  script: z
    .string()
    .optional()
    .describe(
      "Optional JavaScript: a synchronous function body that reads `input` and returns a JSON value. No async or await, no network, files, packages or timers; two seconds and 64 MB at most. Only for computing or transforming data.",
    ),
  inputSchemaJson: z
    .string()
    .optional()
    .describe(
      'With a script: the JSON Schema of its input, as a JSON string. Its type must be "object".',
    ),
  needsApproval: z.boolean().optional(),
  rationale: z.string(),
});

export type SkillProposal = z.infer<typeof skillProposalSchema>;

export function skillProposalBody(proposal: SkillProposal) {
  let inputSchema: unknown = null;
  if (proposal.script && proposal.inputSchemaJson) {
    try {
      inputSchema = JSON.parse(proposal.inputSchemaJson);
    } catch {
      throw new Error("inputSchemaJson is not valid JSON.");
    }
  }
  return {
    name: proposal.name,
    description: proposal.description,
    content: proposal.content,
    script: proposal.script?.trim() ? proposal.script : null,
    inputSchema,
    needsApproval: Boolean(proposal.script && proposal.needsApproval),
  };
}

export const scheduleProposalSchema = z.object({
  name: z.string(),
  frequency: z.enum(SCHEDULE_FREQUENCIES),
  timeOfDay: z
    .string()
    .describe("HH:MM, 24-hour, in the time zone of the person's browser."),
  weekday: z
    .number()
    .int()
    .min(0)
    .max(6)
    .optional()
    .describe("Only for weekly: 0 is Sunday."),
  startDate: z
    .string()
    .optional()
    .describe("Only for monthly: YYYY-MM-DD; its day is the day of the month."),
  input: z
    .string()
    .describe(
      "What the agent is told on each run. May use {{date}}, {{datetime}}, {{last_success_at}} and {{schedule}}.",
    ),
  rationale: z.string(),
});

export type ScheduleProposal = z.infer<typeof scheduleProposalSchema>;

export function scheduleProposalProblems(proposal: ScheduleProposal): string[] {
  const problems: string[] = [];
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(proposal.timeOfDay))
    problems.push("timeOfDay must be HH:MM, 24-hour.");
  if (proposal.frequency === "weekly" && proposal.weekday === undefined)
    problems.push("A weekly schedule needs a weekday.");
  if (
    proposal.frequency === "monthly" &&
    !/^\d{4}-\d{2}-\d{2}$/.test(proposal.startDate ?? "")
  )
    problems.push("A monthly schedule needs a startDate as YYYY-MM-DD.");
  if (!proposal.name.trim()) problems.push("The schedule needs a name.");
  if (!proposal.input.trim()) problems.push("The schedule needs an input.");
  return problems;
}

export const criterionProposalSchema = z.object({
  question: z
    .string()
    .describe(
      "A yes/no question a judge can answer from one run's transcript, where yes means the run was good.",
    ),
  passDescription: z.string().optional(),
  failDescription: z.string().optional(),
  appliesWhen: z
    .string()
    .optional()
    .describe("When the question only makes sense for some runs: which ones."),
  rationale: z.string(),
});

export type CriterionProposal = z.infer<typeof criterionProposalSchema>;

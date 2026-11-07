import {
  AGENT_SLUG_MAX_LENGTH,
  AGENT_SLUG_PATTERN,
  MAX_MEMORY_CHAR_LIMIT,
  RUN_LABEL_MAX_LENGTH,
} from "@agentlathe/db";
import { z } from "zod";
import { isUuid } from "@/lib/api-helpers";
import { MIN_MEMORY_CHAR_LIMIT } from "@/lib/memory-settings";

const uuidSchema = z.string().refine(isUuid, {
  message: "must be a valid uuid",
});

const agentMcpToolSchema = z.object({
  serverId: uuidSchema,
  toolName: z.string().min(1),
  needsApproval: z.boolean().optional(),
});

const slugSchema = z
  .string()
  .max(AGENT_SLUG_MAX_LENGTH)
  .regex(AGENT_SLUG_PATTERN, {
    message:
      "only lowercase letters, digits, dots, underscores and hyphens; must start and end with a letter or digit",
  })
  .refine((value) => !isUuid(value), {
    message: "must not look like a uuid",
  });

const memorySettingsSchema = z.object({
  purpose: z.string().trim().min(1).max(4000),
  charLimit: z
    .number()
    .int()
    .min(MIN_MEMORY_CHAR_LIMIT)
    .max(MAX_MEMORY_CHAR_LIMIT),
  requireApproval: z.boolean(),
});

const memorySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("agent"), settings: memorySettingsSchema }),
  z.object({
    type: z.literal("agent_subject"),
    settings: memorySettingsSchema,
  }),
  z.object({
    type: z.literal("custom"),
    settings: memorySettingsSchema,
    memoryKey: z.string().trim().min(1).max(RUN_LABEL_MAX_LENGTH),
  }),
]);

const base = {
  name: z.string().min(1),
  slug: slugSchema.optional(),
  description: z.string().nullable().optional(),
  model: z.string().min(1),
  systemPrompt: z.string().nullable().optional(),
  maxSteps: z.number().int().positive().max(200).optional(),
  isActive: z.boolean().optional(),
  recordTraffic: z.boolean().optional(),
  autoEvaluate: z.boolean().optional(),
  skillIds: z.array(uuidSchema).optional(),
  toolIds: z.array(uuidSchema).optional(),
  subAgentIds: z.array(uuidSchema).optional(),
  mcpTools: z.array(agentMcpToolSchema).optional(),
  memory: memorySchema.optional(),
};

export const agentCreateSchema = z.object(base);
export const agentUpdateSchema = z.object(base).partial();

export type AgentInput = z.infer<typeof agentCreateSchema>;

import { AGENT_SLUG_MAX_LENGTH, AGENT_SLUG_PATTERN } from "@agentlathe/db";
import { z } from "zod";
import { isUuid } from "@/lib/api-helpers";

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
};

export const agentCreateSchema = z.object(base);
export const agentUpdateSchema = z.object(base).partial();

export type AgentInput = z.infer<typeof agentCreateSchema>;

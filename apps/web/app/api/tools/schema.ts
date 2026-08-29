import { compileInputSchema } from "@agentlathe/runner";
import { z } from "zod";

const base = {
  name: z.string().min(1),
  description: z.string().min(1),
  endpoint: z.url(),
  inputSchema: z
    .record(z.string(), z.unknown())
    .refine((schema) => compileInputSchema(schema) !== null, {
      message: "must be a valid JSON Schema",
    }),
  needsApproval: z.boolean().optional(),
  isActive: z.boolean().optional(),
};

export const toolCreateSchema = z.object(base);
export const toolUpdateSchema = z.object(base).partial();

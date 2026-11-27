import { compileInputSchema } from "@agentlathe/runner";
import { z } from "zod";

export const SKILL_SCRIPT_MAX_LENGTH = 100_000;

const base = {
  name: z.string().min(1),
  description: z.string().min(1),
  content: z.string().min(1),
  script: z.string().trim().min(1).max(SKILL_SCRIPT_MAX_LENGTH).nullable(),
  inputSchema: z
    .record(z.string(), z.unknown())
    .refine((schema) => compileInputSchema(schema) !== null, {
      message: "must be a valid JSON Schema",
    })
    .refine((schema) => schema.type === "object", {
      message: 'must describe an object: "type": "object"',
    })
    .nullable(),
  needsApproval: z.boolean(),
  isActive: z.boolean(),
};

const optional = {
  script: base.script.optional(),
  inputSchema: base.inputSchema.optional(),
  needsApproval: base.needsApproval.optional(),
  isActive: base.isActive.optional(),
};

export const skillCreateSchema = z.object({ ...base, ...optional });
export const skillUpdateSchema = z.object({ ...base, ...optional }).partial();

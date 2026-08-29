import { SECRET_ENV_PREFIX } from "@agentlathe/db";
import { z } from "zod";

const headerValueSchema = z
  .string()
  .refine(
    (value) =>
      !value.startsWith("AGENTLATHE_") || value.startsWith(SECRET_ENV_PREFIX),
    {
      message: `Header values starting with "AGENTLATHE_" are env var references and must start with "${SECRET_ENV_PREFIX}".`,
    },
  );

// buildAuth (runner/helpers.ts) reads only headers: another shape saves, then fails auth.
export const authConfigSchema = z
  .object({ headers: z.record(z.string(), headerValueSchema) })
  .nullable();

const base = {
  name: z.string().min(1),
  serverUrl: z.url(),
  authConfig: authConfigSchema.optional(),
  isActive: z.boolean().optional(),
};

export const mcpServerCreateSchema = z.object(base);
export const mcpServerUpdateSchema = z.object(base).partial();

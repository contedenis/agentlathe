import {
  getSettings,
  MAX_AGENT_RUN_TTL_DAYS,
  setSettings,
} from "@agentlathe/db";
import { z } from "zod";
import { parseBody } from "@/lib/api-helpers";

const trackingSchema = z
  .object({
    trackDashboardRuns: z.boolean().optional(),
    trackV1Runs: z.boolean().optional(),
    trackMcpRuns: z.boolean().optional(),
    agentRunTtlDays: z
      .number()
      .int()
      .min(0)
      .max(MAX_AGENT_RUN_TTL_DAYS)
      .optional(),
    transcriptTtlDays: z
      .number()
      .int()
      .min(0)
      .max(MAX_AGENT_RUN_TTL_DAYS)
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Send at least one field.",
  });

export async function GET() {
  return Response.json(await getSettings());
}

export async function PATCH(req: Request) {
  const parsed = await parseBody(req, trackingSchema);
  if ("error" in parsed) return parsed.error;
  return Response.json(await setSettings(parsed.data));
}

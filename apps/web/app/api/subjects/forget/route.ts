import { forgetSubject } from "@agentlathe/db";
import { RUN_LABEL_MAX_LENGTH } from "@agentlathe/db/constants";
import { z } from "zod";
import { parseBody } from "@/lib/api-helpers";

const forgetSchema = z.object({
  subjectId: z.string().trim().min(1).max(RUN_LABEL_MAX_LENGTH),
});

export async function POST(req: Request) {
  const parsed = await parseBody(req, forgetSchema);
  if ("error" in parsed) return parsed.error;
  return Response.json(await forgetSubject(parsed.data.subjectId));
}

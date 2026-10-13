import {
  DEFAULT_CRITERION_FAIL_BELOW,
  DEFAULT_CRITERION_PASS_ABOVE,
} from "@agentlathe/db/constants";
import { criterionDraftSchema } from "@/app/api/agents/[id]/criteria/schema";
import { dbErrorResponse, isUuid, parseBody } from "@/lib/api-helpers";
import { previewCriterion } from "@/lib/evaluations";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const parsed = await parseBody(req, criterionDraftSchema);
  if ("error" in parsed) return parsed.error;
  const draft = parsed.data;

  try {
    const result = await previewCriterion(id, {
      question: draft.question,
      passDescription: draft.passDescription ?? null,
      failDescription: draft.failDescription ?? null,
      appliesWhen: draft.appliesWhen ?? null,
      failBelow: draft.failBelow ?? DEFAULT_CRITERION_FAIL_BELOW,
      passAbove: draft.passAbove ?? DEFAULT_CRITERION_PASS_ABOVE,
    });
    if ("error" in result)
      return Response.json({ error: "Run not found." }, { status: 404 });
    if ("skipped" in result) return Response.json(result);
    return Response.json(result.preview);
  } catch (err) {
    return dbErrorResponse(err);
  }
}

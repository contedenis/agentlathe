import { z } from "zod";
import { dbErrorResponse, isUuid, parseBody } from "@/lib/api-helpers";
import { evaluateRun } from "@/lib/evaluations";

const evaluateSchema = z.object({
  criterionIds: z
    .array(z.string().refine(isUuid, { message: "must be a valid uuid" }))
    .min(1)
    .optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const parsed = await parseBody(req, evaluateSchema, { allowEmpty: true });
  if ("error" in parsed) return parsed.error;

  try {
    const result = await evaluateRun(id, parsed.data);
    if ("error" in result) {
      return result.error === "run_not_found"
        ? Response.json({ error: "Run not found." }, { status: 404 })
        : Response.json(
            { error: "Some criteria do not belong to this run's agent." },
            { status: 400 },
          );
    }
    return Response.json(result);
  } catch (err) {
    return dbErrorResponse(err);
  }
}

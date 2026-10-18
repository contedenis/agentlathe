import { after } from "next/server";
import { isUuid } from "@/lib/api-helpers";
import { runNow } from "@/lib/scheduler/engine";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const result = await runNow(id);
  switch (result.status) {
    case "not_found":
      return Response.json({ error: "Schedule not found." }, { status: 404 });
    case "busy":
      return Response.json(
        { error: "A run of this schedule is still in progress." },
        { status: 409 },
      );
    case "blocked":
      return Response.json(
        { error: result.reason, occurrenceId: result.occurrenceId },
        { status: 422 },
      );
    default:
      after(result.done);
      return Response.json(
        { occurrenceId: result.occurrenceId },
        { status: 202 },
      );
  }
}

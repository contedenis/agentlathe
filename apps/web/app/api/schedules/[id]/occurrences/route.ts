import { isUuid } from "@/lib/api-helpers";
import { listScheduleOccurrences } from "@/lib/queries-schedules";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });
  return Response.json(await listScheduleOccurrences(id));
}

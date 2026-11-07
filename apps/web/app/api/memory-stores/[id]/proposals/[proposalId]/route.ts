import { decideMemoryProposal } from "@agentlathe/db";
import { z } from "zod";
import { isUuid, parseBody } from "@/lib/api-helpers";
import { scheduleCompaction } from "@/lib/memory-compaction";
import { invalidId, memoryErrorResponse } from "../../../entries";

const decisionSchema = z.object({ approve: z.boolean() });

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; proposalId: string }> },
) {
  const { id, proposalId } = await params;
  if (!isUuid(id) || !isUuid(proposalId)) return invalidId();
  const parsed = await parseBody(req, decisionSchema);
  if ("error" in parsed) return parsed.error;
  try {
    const decision = await decideMemoryProposal(
      id,
      proposalId,
      parsed.data.approve,
    );
    if (decision.status === "approved")
      scheduleCompaction([
        { storeId: id, partitionKey: decision.partitionKey },
      ]);
    return Response.json({ status: decision.status, reason: decision.reason });
  } catch (err) {
    return memoryErrorResponse(err);
  }
}

import {
  agentMcpTools,
  agentSkills,
  agentSubAgents,
  agentTools,
  type db,
} from "@agentlathe/db";
import { eq } from "drizzle-orm";
import type { AgentInput } from "./schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type RelationsInput = Pick<
  Partial<AgentInput>,
  "skillIds" | "toolIds" | "subAgentIds" | "mcpTools"
>;

export async function replaceAgentRelations(
  tx: Tx,
  agentId: string,
  input: RelationsInput,
) {
  if (input.skillIds !== undefined) {
    await tx.delete(agentSkills).where(eq(agentSkills.agentId, agentId));
    if (input.skillIds.length > 0) {
      await tx
        .insert(agentSkills)
        .values(input.skillIds.map((skillId) => ({ agentId, skillId })));
    }
  }

  if (input.toolIds !== undefined) {
    await tx.delete(agentTools).where(eq(agentTools.agentId, agentId));
    if (input.toolIds.length > 0) {
      await tx
        .insert(agentTools)
        .values(input.toolIds.map((toolId) => ({ agentId, toolId })));
    }
  }

  if (input.subAgentIds !== undefined) {
    await tx.delete(agentSubAgents).where(eq(agentSubAgents.parentId, agentId));
    if (input.subAgentIds.length > 0) {
      await tx
        .insert(agentSubAgents)
        .values(
          input.subAgentIds.map((childId) => ({ parentId: agentId, childId })),
        );
    }
  }

  if (input.mcpTools !== undefined) {
    await tx.delete(agentMcpTools).where(eq(agentMcpTools.agentId, agentId));
    if (input.mcpTools.length > 0) {
      await tx.insert(agentMcpTools).values(
        input.mcpTools.map(({ serverId, toolName, needsApproval }) => ({
          agentId,
          serverId,
          toolName,
          needsApproval: needsApproval ?? false,
        })),
      );
    }
  }
}

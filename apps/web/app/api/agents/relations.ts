import {
  agentKnowledge,
  agentMcpTools,
  agentSkills,
  agentSubAgents,
  agentTools,
  type db,
  memoryStores,
} from "@agentlathe/db";
import { and, eq, ne } from "drizzle-orm";
import { MEMORY_SCOPE_LABEL } from "@/lib/memory-rules";
import type { AgentInput } from "./schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type RelationsInput = Pick<
  Partial<AgentInput>,
  "skillIds" | "toolIds" | "subAgentIds" | "mcpTools" | "memory" | "knowledge"
>;

type MemoryInput = NonNullable<AgentInput["memory"]>;

async function saveMemory(tx: Tx, agentId: string, memory: MemoryInput) {
  await tx
    .update(memoryStores)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(memoryStores.ownerAgentId, agentId),
        memory.type === "none"
          ? undefined
          : ne(memoryStores.scope, memory.type),
      ),
    );
  if (memory.type === "none") return;

  const values = {
    ...memory.settings,
    memoryKey: memory.type === "custom" ? memory.memoryKey : null,
    isActive: true,
    updatedAt: new Date(),
  };
  const [existing] = await tx
    .update(memoryStores)
    .set(values)
    .where(
      and(
        eq(memoryStores.ownerAgentId, agentId),
        eq(memoryStores.scope, memory.type),
      ),
    )
    .returning({ id: memoryStores.id });
  if (!existing)
    await tx.insert(memoryStores).values({
      ...values,
      name: MEMORY_SCOPE_LABEL[memory.type],
      scope: memory.type,
      ownerAgentId: agentId,
    });
}

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

  if (input.memory) await saveMemory(tx, agentId, input.memory);

  if (input.knowledge !== undefined) {
    await tx.delete(agentKnowledge).where(eq(agentKnowledge.agentId, agentId));
    if (input.knowledge.length > 0) {
      await tx
        .insert(agentKnowledge)
        .values(input.knowledge.map((link) => ({ agentId, ...link })));
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

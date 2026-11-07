import {
  agentKnowledge,
  agents,
  db,
  isUuid,
  type KnowledgeDocumentStatus,
  type KnowledgeMediaType,
  type KnowledgeMode,
  knowledgeCollections,
  knowledgeDocuments,
} from "@agentlathe/db";
import { embeddingModelId } from "@agentlathe/runner";
import { asc, count, eq, isNotNull, sql } from "drizzle-orm";

export async function listCollections() {
  const [collections, documents, links] = await Promise.all([
    db
      .select({
        id: knowledgeCollections.id,
        name: knowledgeCollections.name,
        description: knowledgeCollections.description,
      })
      .from(knowledgeCollections)
      .orderBy(asc(knowledgeCollections.name)),
    db
      .select({
        collectionId: knowledgeDocuments.collectionId,
        documents: count(),
        size: sql<number>`coalesce(sum(${knowledgeDocuments.size}), 0)::int`,
        waiting: sql<number>`count(*) filter (where ${knowledgeDocuments.status} in ('pending','processing'))::int`,
        failed: sql<number>`count(*) filter (where ${knowledgeDocuments.status} = 'failed')::int`,
      })
      .from(knowledgeDocuments)
      .groupBy(knowledgeDocuments.collectionId),
    db
      .select({
        collectionId: agentKnowledge.collectionId,
        agents: count(),
      })
      .from(agentKnowledge)
      .groupBy(agentKnowledge.collectionId),
  ]);
  const docsOf = new Map(documents.map((row) => [row.collectionId, row]));
  const agentsOf = new Map(links.map((row) => [row.collectionId, row.agents]));
  return collections.map((collection) => ({
    ...collection,
    documents: docsOf.get(collection.id)?.documents ?? 0,
    size: docsOf.get(collection.id)?.size ?? 0,
    waiting: docsOf.get(collection.id)?.waiting ?? 0,
    failed: docsOf.get(collection.id)?.failed ?? 0,
    agents: agentsOf.get(collection.id) ?? 0,
  }));
}

export type CollectionListRow = Awaited<
  ReturnType<typeof listCollections>
>[number];

export async function getCollection(id: string) {
  if (!isUuid(id)) return null;
  const [[collection], documents, agentRows] = await Promise.all([
    db
      .select()
      .from(knowledgeCollections)
      .where(eq(knowledgeCollections.id, id)),
    db
      .select({
        id: knowledgeDocuments.id,
        filename: knowledgeDocuments.filename,
        mediaType: knowledgeDocuments.mediaType,
        size: knowledgeDocuments.size,
        pages: knowledgeDocuments.pages,
        chars: knowledgeDocuments.chars,
        status: knowledgeDocuments.status,
        error: knowledgeDocuments.error,
        attempts: knowledgeDocuments.attempts,
        embeddingModel: knowledgeDocuments.embeddingModel,
        createdAt: knowledgeDocuments.createdAt,
      })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.collectionId, id))
      .orderBy(asc(knowledgeDocuments.filename), asc(knowledgeDocuments.id)),
    db
      .select({
        id: agents.id,
        name: agents.name,
        mode: agentKnowledge.mode,
      })
      .from(agentKnowledge)
      .innerJoin(agents, eq(agents.id, agentKnowledge.agentId))
      .where(eq(agentKnowledge.collectionId, id))
      .orderBy(asc(agents.name)),
  ]);
  if (!collection) return null;
  return {
    ...collection,
    embeddingModel: embeddingModelId(),
    documents: documents.map((doc) => ({
      ...doc,
      mediaType: doc.mediaType as KnowledgeMediaType,
      status: doc.status as KnowledgeDocumentStatus,
    })),
    agents: agentRows.map((row) => ({
      ...row,
      mode: row.mode as KnowledgeMode,
    })),
  };
}

export type CollectionDetail = NonNullable<
  Awaited<ReturnType<typeof getCollection>>
>;

export const DOCUMENT_PREVIEW_CHARS = 100_000;

export async function getKnowledgeDocument(id: string) {
  if (!isUuid(id)) return null;
  const [doc] = await db
    .select({
      id: knowledgeDocuments.id,
      collectionId: knowledgeDocuments.collectionId,
      collectionName: knowledgeCollections.name,
      filename: knowledgeDocuments.filename,
      mediaType: knowledgeDocuments.mediaType,
      size: knowledgeDocuments.size,
      pages: knowledgeDocuments.pages,
      chars: knowledgeDocuments.chars,
      text: sql<
        string | null
      >`left(${knowledgeDocuments.text}, ${DOCUMENT_PREVIEW_CHARS})`,
      status: knowledgeDocuments.status,
      error: knowledgeDocuments.error,
      embeddingModel: knowledgeDocuments.embeddingModel,
      createdAt: knowledgeDocuments.createdAt,
    })
    .from(knowledgeDocuments)
    .innerJoin(
      knowledgeCollections,
      eq(knowledgeCollections.id, knowledgeDocuments.collectionId),
    )
    .where(eq(knowledgeDocuments.id, id));
  return doc
    ? {
        ...doc,
        mediaType: doc.mediaType as KnowledgeMediaType,
        status: doc.status as KnowledgeDocumentStatus,
      }
    : null;
}

export async function listCollectionOptions() {
  const [collections, sizes] = await Promise.all([
    db
      .select({
        id: knowledgeCollections.id,
        name: knowledgeCollections.name,
        description: knowledgeCollections.description,
      })
      .from(knowledgeCollections)
      .orderBy(asc(knowledgeCollections.name)),
    db
      .select({
        collectionId: knowledgeDocuments.collectionId,
        chars: sql<number>`coalesce(sum(${knowledgeDocuments.chars}), 0)::int`,
      })
      .from(knowledgeDocuments)
      .where(isNotNull(knowledgeDocuments.text))
      .groupBy(knowledgeDocuments.collectionId),
  ]);
  const charsOf = new Map(sizes.map((row) => [row.collectionId, row.chars]));
  return collections.map((collection) => ({
    ...collection,
    chars: charsOf.get(collection.id) ?? 0,
  }));
}

export type CollectionOption = Awaited<
  ReturnType<typeof listCollectionOptions>
>[number];

export async function listAgentKnowledge(agentId: string) {
  if (!isUuid(agentId)) return [];
  const rows = await db
    .select({
      collectionId: knowledgeCollections.id,
      name: knowledgeCollections.name,
      mode: agentKnowledge.mode,
    })
    .from(agentKnowledge)
    .innerJoin(
      knowledgeCollections,
      eq(knowledgeCollections.id, agentKnowledge.collectionId),
    )
    .where(eq(agentKnowledge.agentId, agentId))
    .orderBy(asc(knowledgeCollections.name));
  return rows.map((row) => ({ ...row, mode: row.mode as KnowledgeMode }));
}

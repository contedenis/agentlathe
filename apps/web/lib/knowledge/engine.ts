import {
  db,
  type KnowledgeMediaType,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeFiles,
  PROCESSING_ATTEMPTS,
  PROCESSING_STALE_MINUTES,
} from "@agentlathe/db";
import { embeddingModelId, embedTexts } from "@agentlathe/runner";
import { and, eq, inArray, sql } from "drizzle-orm";
import { after } from "next/server";
import { chunkPages } from "./chunking";
import {
  documentPages,
  extractDocument,
  UnreadableDocumentError,
} from "./extract";

const CONCURRENCY = 2;
const EMBED_BATCH = 100;
const RETRY_AFTER_SECONDS = 120;

type Claim = { id: string; claimId: string; attempts: number };

const shared = globalThis as {
  __agentlatheKnowledge?: {
    running: number;
    owned: Map<string, Claim>;
    stopping?: boolean;
  };
};
shared.__agentlatheKnowledge ??= { running: 0, owned: new Map() };
const state = shared.__agentlatheKnowledge;

const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const fence = (claim: Claim) =>
  and(
    eq(knowledgeDocuments.id, claim.id),
    eq(knowledgeDocuments.status, "processing"),
    eq(knowledgeDocuments.claimId, claim.claimId),
  );

async function requeueOtherModels(model: string): Promise<void> {
  await db
    .update(knowledgeDocuments)
    .set({ status: "pending", attempts: 0, error: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(knowledgeDocuments.status, "ready"),
        sql`${knowledgeDocuments.embeddingModel} is distinct from ${model}`,
      ),
    );
}

async function failExhausted(): Promise<void> {
  await db.transaction(async (tx) => {
    const failed = await tx
      .update(knowledgeDocuments)
      .set({
        status: "failed",
        error: `Processing stopped before finishing ${PROCESSING_ATTEMPTS} times.`,
        claimedAt: null,
        claimId: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(knowledgeDocuments.status, "processing"),
          sql`${knowledgeDocuments.claimedAt} < now() - make_interval(mins => ${PROCESSING_STALE_MINUTES})`,
          sql`${knowledgeDocuments.attempts} >= ${PROCESSING_ATTEMPTS}`,
        ),
      )
      .returning({ id: knowledgeDocuments.id });
    if (failed.length > 0)
      await tx.delete(knowledgeChunks).where(
        inArray(
          knowledgeChunks.documentId,
          failed.map((doc) => doc.id),
        ),
      );
  });
}

async function claimNext(): Promise<Claim | null> {
  const { rows } = await db.execute<Claim>(sql`
    update knowledge_documents
    set status = 'processing', claimed_at = now(), claim_id = gen_random_uuid(), attempts = attempts + 1, updated_at = now()
    where id = (
      select id from knowledge_documents
      where attempts < ${PROCESSING_ATTEMPTS}
        and (
          (status = 'pending' and (claimed_at is null or claimed_at < now() - make_interval(secs => ${RETRY_AFTER_SECONDS})))
          or (status = 'processing' and claimed_at < now() - make_interval(mins => ${PROCESSING_STALE_MINUTES}))
        )
      order by created_at
      limit 1
      for update skip locked
    )
    returning id, claim_id as "claimId", attempts`);
  return rows[0] ?? null;
}

async function readText(
  claim: Claim,
): Promise<{ text: string; mediaType: KnowledgeMediaType } | null> {
  const [doc] = await db
    .select({
      text: knowledgeDocuments.text,
      mediaType: knowledgeDocuments.mediaType,
    })
    .from(knowledgeDocuments)
    .where(fence(claim));
  if (!doc) return null;
  const mediaType = doc.mediaType as KnowledgeMediaType;
  if (doc.text !== null) return { text: doc.text, mediaType };

  const [original] = await db
    .select({ bytes: knowledgeFiles.bytes })
    .from(knowledgeFiles)
    .where(eq(knowledgeFiles.documentId, claim.id));
  if (!original) return null;
  const { text, pages } = await extractDocument(original.bytes, mediaType);
  const saved = await db
    .update(knowledgeDocuments)
    .set({ text, pages, chars: text.length, updatedAt: sql`now()` })
    .where(fence(claim))
    .returning({ id: knowledgeDocuments.id });
  return saved.length ? { text, mediaType } : null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function writeFenced(
  claim: Claim,
  write: (tx: Tx) => Promise<unknown>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const held = await tx
      .update(knowledgeDocuments)
      .set({ claimedAt: sql`now()` })
      .where(fence(claim))
      .returning({ id: knowledgeDocuments.id });
    if (held.length === 0) return false;
    await write(tx);
    return true;
  });
}

async function markReady(claim: Claim, model: string): Promise<void> {
  await db
    .update(knowledgeDocuments)
    .set({
      status: "ready",
      embeddingModel: model,
      error: null,
      claimedAt: null,
      claimId: null,
      updatedAt: sql`now()`,
    })
    .where(fence(claim));
}

async function fail(claim: Claim, err: unknown): Promise<void> {
  const permanent =
    err instanceof UnreadableDocumentError ||
    claim.attempts >= PROCESSING_ATTEMPTS;
  await db.transaction(async (tx) => {
    const [failed] = await tx
      .update(knowledgeDocuments)
      .set({
        status: permanent ? "failed" : "pending",
        error: errorMessage(err),
        claimedAt: permanent ? null : sql`now()`,
        claimId: null,
        updatedAt: sql`now()`,
      })
      .where(fence(claim))
      .returning({ id: knowledgeDocuments.id });
    if (failed && permanent)
      await tx
        .delete(knowledgeChunks)
        .where(eq(knowledgeChunks.documentId, claim.id));
  });
}

async function processClaim(claim: Claim): Promise<void> {
  const model = embeddingModelId();
  try {
    const doc = await readText(claim);
    if (!doc) return;
    const chunks = chunkPages(documentPages(doc.text, doc.mediaType), {
      paged: doc.mediaType === "application/pdf",
    });
    const cleared = await writeFenced(claim, (tx) =>
      tx
        .delete(knowledgeChunks)
        .where(eq(knowledgeChunks.documentId, claim.id)),
    );
    if (!cleared) return;
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const embeddings = await embedTexts(batch.map((chunk) => chunk.content));
      const written = await writeFenced(claim, (tx) =>
        tx.insert(knowledgeChunks).values(
          batch.map((chunk, n) => ({
            ...chunk,
            documentId: claim.id,
            embedding: embeddings[n],
            embeddingModel: model,
          })),
        ),
      );
      if (!written) return;
    }
    await markReady(claim, model);
  } catch (err) {
    await fail(claim, err).catch((failure) =>
      console.error("recording a knowledge failure failed", failure),
    );
  }
}

async function worker(): Promise<void> {
  while (!state.stopping) {
    const claim = await claimNext();
    if (!claim) return;
    if (state.stopping) {
      await giveBack([claim.claimId]);
      return;
    }
    state.owned.set(claim.claimId, claim);
    try {
      await processClaim(claim);
    } finally {
      state.owned.delete(claim.claimId);
    }
  }
}

export async function processKnowledge(): Promise<void> {
  await Promise.all([requeueOtherModels(embeddingModelId()), failExhausted()]);
  const workers: Promise<void>[] = [];
  while (state.running < CONCURRENCY) {
    state.running += 1;
    workers.push(
      worker()
        .catch((err) => console.error("knowledge processing failed", err))
        .finally(() => {
          state.running -= 1;
        }),
    );
  }
  await Promise.all(workers);
}

async function giveBack(claimIds: string[]): Promise<void> {
  if (claimIds.length === 0) return;
  await db
    .update(knowledgeDocuments)
    .set({
      status: "pending",
      attempts: sql`${knowledgeDocuments.attempts} - 1`,
      claimedAt: null,
      claimId: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(knowledgeDocuments.status, "processing"),
        inArray(knowledgeDocuments.claimId, claimIds),
      ),
    );
}

export async function stopKnowledgeProcessing(): Promise<void> {
  state.stopping = true;
  await giveBack([...state.owned.keys()]);
}

export function scheduleKnowledgeProcessing(): void {
  after(() =>
    processKnowledge().catch((err) =>
      console.error("knowledge processing failed", err),
    ),
  );
}

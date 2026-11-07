import {
  db,
  MemoryWriteError,
  type MemoryWriteErrorCode,
  memoryEntries,
} from "@agentlathe/db";
import { and, eq } from "drizzle-orm";

const STATUS: Record<MemoryWriteErrorCode, number> = {
  store_not_found: 404,
  entry_not_found: 404,
  pinned: 409,
  invalid_content: 400,
  full: 409,
  proposal_not_found: 404,
  stale: 409,
};

export function memoryErrorResponse(err: unknown): Response {
  if (err instanceof MemoryWriteError)
    return Response.json({ error: err.message }, { status: STATUS[err.code] });
  throw err;
}

export async function findEntry(storeId: string, entryId: string) {
  const [entry] = await db
    .select()
    .from(memoryEntries)
    .where(
      and(eq(memoryEntries.id, entryId), eq(memoryEntries.storeId, storeId)),
    );
  return entry ?? null;
}

export const entryNotFound = () =>
  Response.json({ error: "Memory entry not found." }, { status: 404 });

export const invalidId = () =>
  Response.json({ error: "Invalid id." }, { status: 400 });

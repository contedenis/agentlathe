import {
  MEMORY_ENTRY_MAX_LENGTH,
  RUN_LABEL_MAX_LENGTH,
} from "@agentlathe/db/constants";
import { z } from "zod";

const label = z.string().trim().min(1).max(RUN_LABEL_MAX_LENGTH);

export const memoryEntryCreateSchema = z.object({
  subjectId: label.optional(),
  content: z.string().max(MEMORY_ENTRY_MAX_LENGTH * 2),
});

export const memoryEntryUpdateSchema = z.union([
  z.object({ content: z.string().max(MEMORY_ENTRY_MAX_LENGTH * 2) }),
  z.object({ pinned: z.boolean() }),
]);

export const memoryEntryRestoreSchema = z.object({ versionId: z.uuid() });

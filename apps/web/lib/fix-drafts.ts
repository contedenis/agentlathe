import {
  FIX_DRAFT_CATEGORIES,
  FIX_DRAFT_STATUSES,
} from "@agentlathe/db/constants";
import { z } from "zod";

export { FIX_DRAFT_CATEGORIES, FIX_DRAFT_STATUSES };

export const FIX_DRAFT_CATEGORY_LABEL: Record<
  (typeof FIX_DRAFT_CATEGORIES)[number],
  string
> = {
  prompt: "System prompt",
  tool_definition: "Tool definition",
  tool_policy: "Tool approval policy",
  missing_tool: "Missing tool",
  model: "Model choice",
  other: "Other",
};

const fixDraftAnchorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool_call"), toolCallId: z.string() }),
  z.object({ type: z.literal("turn") }),
]);

export type FixDraftAnchor = z.infer<typeof fixDraftAnchorSchema>;

export const fixDraftSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  anchor: fixDraftAnchorSchema,
  category: z.enum(FIX_DRAFT_CATEGORIES),
  rationale: z.string().min(1),
  proposedValue: z.string().nullable(),
  status: z.enum(FIX_DRAFT_STATUSES),
  createdAt: z.string(),
});

export type FixDraft = z.infer<typeof fixDraftSchema>;

export const fixDraftCreateSchema = z.object({
  messageId: z.string().min(1),
  anchor: fixDraftAnchorSchema,
  category: z.enum(FIX_DRAFT_CATEGORIES),
  rationale: z.string().min(1),
  proposedValue: z.string().nullable().optional(),
});

export const fixDraftUpdateSchema = z
  .object({
    status: z.enum(FIX_DRAFT_STATUSES).optional(),
    category: z.enum(FIX_DRAFT_CATEGORIES).optional(),
    rationale: z.string().min(1).optional(),
    proposedValue: z.string().nullable().optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "at least one field is required",
  });

export function anchorKey(messageId: string, anchor: FixDraftAnchor): string {
  return anchor.type === "tool_call"
    ? `tool:${anchor.toolCallId}`
    : `msg:${messageId}`;
}

type FixDraftRow = {
  id: string;
  messageId: string;
  anchor: unknown;
  category: string;
  rationale: string;
  proposedValue: string | null;
  status: string;
  createdAt: Date | null;
};

export function toFixDrafts(rows: FixDraftRow[]): FixDraft[] {
  return rows.flatMap((row) => {
    const parsed = fixDraftSchema.safeParse({
      ...row,
      createdAt: (row.createdAt ?? new Date()).toISOString(),
    });
    return parsed.success ? [parsed.data] : [];
  });
}

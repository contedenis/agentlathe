"use client";

import { MessageSquareTextIcon } from "lucide-react";
import { FIX_DRAFT_CATEGORY_LABEL, type FixDraft } from "@/lib/fix-drafts";
import { cn } from "@/lib/utils";

export function FixDraftChip({
  draft,
  onClick,
}: {
  draft: FixDraft;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={`${draft.rationale} — click to edit`}
      onClick={onClick}
      className={cn(
        "inline-flex max-w-md items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/10",
        draft.status !== "open" && "opacity-60",
      )}
    >
      <MessageSquareTextIcon className="size-3 shrink-0" />
      <span className="truncate">
        {FIX_DRAFT_CATEGORY_LABEL[draft.category]} · {draft.rationale}
      </span>
    </button>
  );
}

"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { AnnotateTarget } from "@/components/transcript-history";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  FIX_DRAFT_CATEGORIES,
  FIX_DRAFT_CATEGORY_LABEL,
  type FixDraft,
} from "@/lib/fix-drafts";
import { apiRequest } from "@/lib/mutate";

function FixDraftForm({
  endpoint,
  target,
  editing,
  onOpenChange,
  onCreated,
  onUpdated,
}: {
  endpoint: string;
  target: AnnotateTarget | null;
  editing?: FixDraft | null;
  onOpenChange: (open: boolean) => void;
  onCreated: (draft: FixDraft) => void;
  onUpdated?: (draft: FixDraft) => void;
}) {
  const [category, setCategory] = useState<
    (typeof FIX_DRAFT_CATEGORIES)[number]
  >(editing?.category ?? "prompt");
  const [rationale, setRationale] = useState(editing?.rationale ?? "");
  const [proposedValue, setProposedValue] = useState(
    editing?.proposedValue ?? "",
  );
  const [pending, setPending] = useState(false);

  async function handleSubmit() {
    if (rationale.trim() === "") return;
    setPending(true);
    try {
      if (editing) {
        const draft = await apiRequest<FixDraft>(`${endpoint}/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            category,
            rationale: rationale.trim(),
            proposedValue: proposedValue.trim() || null,
          }),
        });
        toast.success("Note updated.");
        onUpdated?.(draft);
      } else {
        if (!target) return;
        const draft = await apiRequest<FixDraft>(endpoint, {
          method: "POST",
          body: JSON.stringify({
            messageId: target.messageId,
            anchor: target.anchor,
            category,
            rationale: rationale.trim(),
            proposedValue: proposedValue.trim() || null,
          }),
        });
        toast.success("Note saved.");
        onCreated(draft);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not save the note.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editing ? "Edit fix note" : "Note a fix"}</DialogTitle>
        <DialogDescription>
          {editing
            ? "Adjust the note; its status is managed from the panel."
            : `${target?.label} — pick which lever of the agent the problem points at. It lands in this run's "Fix Drafts" panel.`}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fix-draft-category">Category</Label>
          <Select
            value={category}
            onValueChange={(value) =>
              setCategory(value as (typeof FIX_DRAFT_CATEGORIES)[number])
            }
          >
            <SelectTrigger id="fix-draft-category" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FIX_DRAFT_CATEGORIES.map((value) => (
                <SelectItem key={value} value={value}>
                  {FIX_DRAFT_CATEGORY_LABEL[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fix-draft-rationale">Rationale</Label>
          <Textarea
            id="fix-draft-rationale"
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
            placeholder="e.g. the tool picked the wrong value for X, or the agent should not have asked this again."
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fix-draft-proposed-value">
            Proposed change (optional)
          </Label>
          <Textarea
            id="fix-draft-proposed-value"
            value={proposedValue}
            onChange={(event) => setProposedValue(event.target.value)}
            placeholder="e.g. add to the system prompt: 'never ask for X if it is already in context'."
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          disabled={pending || rationale.trim() === ""}
          onClick={handleSubmit}
        >
          {pending ? "Saving..." : editing ? "Save changes" : "Save note"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function FixDraftDialog({
  endpoint,
  target,
  editing,
  onOpenChange,
  onCreated,
  onUpdated,
}: {
  endpoint: string;
  target: AnnotateTarget | null;
  editing?: FixDraft | null;
  onOpenChange: (open: boolean) => void;
  onCreated: (draft: FixDraft) => void;
  onUpdated?: (draft: FixDraft) => void;
}) {
  const open = target !== null || editing != null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Keyed so switching between create and per-draft edit reseeds the form. */}
        <FixDraftForm
          key={editing?.id ?? "create"}
          endpoint={endpoint}
          target={target}
          editing={editing}
          onOpenChange={onOpenChange}
          onCreated={onCreated}
          onUpdated={onUpdated}
        />
      </DialogContent>
    </Dialog>
  );
}

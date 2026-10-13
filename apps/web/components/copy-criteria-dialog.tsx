"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { apiRequest } from "@/lib/mutate";
import type { CriteriaCopySource } from "@/lib/queries";

function CopyCriteriaForm({
  agentId,
  sources,
  onOpenChange,
}: {
  agentId: string;
  sources: CriteriaCopySource[];
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [sourceId, setSourceId] = useState(sources[0]?.agentId ?? "");
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const source = sources.find((candidate) => candidate.agentId === sourceId);
  const selected = (source?.criteria ?? []).filter(
    (criterion) => !unchecked.has(criterion.id),
  );

  function toggle(criterionId: string, checked: boolean) {
    setUnchecked((current) => {
      const next = new Set(current);
      if (checked) next.delete(criterionId);
      else next.add(criterionId);
      return next;
    });
  }

  async function handleCopy() {
    setError(null);
    setPending(true);
    const copiedIds: string[] = [];
    try {
      for (const criterion of selected) {
        await apiRequest(`/api/agents/${agentId}/criteria`, {
          method: "POST",
          body: JSON.stringify({
            question: criterion.question,
            passDescription: criterion.passDescription,
            failDescription: criterion.failDescription,
            appliesWhen: criterion.appliesWhen,
            failBelow: criterion.failBelow,
            passAbove: criterion.passAbove,
          }),
        });
        copiedIds.push(criterion.id);
      }
      toast.success(
        `Copied ${copiedIds.length} ${copiedIds.length === 1 ? "criterion" : "criteria"}.`,
      );
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error.";
      setUnchecked((current) => new Set([...current, ...copiedIds]));
      setError(
        copiedIds.length > 0
          ? `Copied ${copiedIds.length} of ${selected.length}, then failed: ${message}`
          : message,
      );
    } finally {
      setPending(false);
      if (copiedIds.length > 0) router.refresh();
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Copy criteria from another agent</DialogTitle>
        <DialogDescription>
          Copies are independent: later edits to either agent's criteria do not
          affect the other.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="copy-source-agent">Agent</Label>
        <Select
          value={sourceId}
          items={sources.map((candidate) => ({
            value: candidate.agentId,
            label: candidate.agentName,
          }))}
          onValueChange={(value) => {
            setSourceId(value as string);
            setUnchecked(new Set());
          }}
        >
          <SelectTrigger id="copy-source-agent" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sources.map((candidate) => (
              <SelectItem key={candidate.agentId} value={candidate.agentId}>
                {candidate.agentName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
        {(source?.criteria ?? []).map((criterion) => (
          <div
            key={criterion.id}
            className="flex items-start gap-2 rounded-lg border p-2.5"
          >
            <Checkbox
              id={`copy-${criterion.id}`}
              checked={!unchecked.has(criterion.id)}
              onCheckedChange={(checked) => toggle(criterion.id, checked)}
              className="mt-0.5"
            />
            <Label
              htmlFor={`copy-${criterion.id}`}
              className="cursor-pointer items-start text-sm leading-snug font-normal"
            >
              {criterion.question}
            </Label>
          </div>
        ))}
      </div>

      <DialogFooter>
        {error && (
          <p role="alert" className="mr-auto text-sm text-destructive">
            {error}
          </p>
        )}
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button
          disabled={pending || selected.length === 0}
          onClick={handleCopy}
        >
          {pending
            ? "Copying..."
            : `Copy ${selected.length} ${selected.length === 1 ? "criterion" : "criteria"}`}
        </Button>
      </DialogFooter>
    </>
  );
}

export function CopyCriteriaDialog({
  agentId,
  open,
  onOpenChange,
  sources,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: CriteriaCopySource[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <CopyCriteriaForm
          agentId={agentId}
          sources={sources}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}

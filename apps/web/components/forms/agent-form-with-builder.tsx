"use client";

import { SparklesIcon } from "lucide-react";
import { type ComponentProps, useRef, useState } from "react";
import { toast } from "sonner";
import { type AddressedNote, BuilderPanel } from "@/components/builder-panel";
import { AgentForm } from "@/components/forms/agent-form";
import { Button } from "@/components/ui/button";
import type { AgentDraft } from "@/lib/builder/proposal";
import { apiRequest } from "@/lib/mutate";

async function markApplied(notes: AddressedNote[]) {
  try {
    const outcomes = await Promise.allSettled(
      notes.map((note) =>
        apiRequest(`/api/runs/${note.runId}/fix-drafts/${note.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "applied" }),
        }),
      ),
    );
    const failed = outcomes.filter(
      (outcome) => outcome.status === "rejected",
    ).length;
    if (failed === 0)
      toast.success(
        notes.length === 1 ? "Note marked applied." : "Notes marked applied.",
      );
    else
      toast.error(
        `${notes.length - failed} of ${notes.length} notes marked applied; the rest could not be updated.`,
      );
  } catch (error) {
    toast.error(
      error instanceof Error ? error.message : "Could not update the notes.",
    );
  }
}

export function AgentFormWithBuilder({
  builderConfigured,
  startOpen = false,
  ...formProps
}: Omit<ComponentProps<typeof AgentForm>, "draft" | "onSaved"> & {
  builderConfigured: boolean;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [loaded, setLoaded] = useState<{
    draft: AgentDraft;
    notes: AddressedNote[];
    key: number;
  }>();
  const { initial } = formProps;
  const dirty = useRef(false);

  return (
    <div className="flex flex-col gap-4">
      <Button
        variant="outline"
        className="self-start"
        onClick={() => setOpen(true)}
      >
        <SparklesIcon />
        {initial ? "Improve it with the builder" : "Describe it to the builder"}
      </Button>
      <div
        onChangeCapture={() => {
          dirty.current = true;
        }}
      >
        <AgentForm
          key={loaded?.key ?? 0}
          draft={loaded?.draft}
          onSaved={() => {
            const notes = loaded?.notes ?? [];
            if (notes.length === 0) return;
            toast(
              notes.length === 1
                ? "This change answered 1 open note."
                : `This change answered ${notes.length} open notes.`,
              {
                duration: 20_000,
                action: {
                  label: "Mark applied",
                  onClick: () => void markApplied(notes),
                },
              },
            );
          }}
          {...formProps}
        />
      </div>
      <BuilderPanel
        open={open}
        onOpenChange={setOpen}
        configured={builderConfigured}
        storageKey={`builder:${initial?.id ?? "new"}`}
        agent={
          initial
            ? { id: initial.id, name: initial.name, current: initial }
            : undefined
        }
        onLoadAgent={(draft, notes) => {
          if (
            dirty.current &&
            !window.confirm(
              "Loading the proposal replaces what you changed in the form.",
            )
          )
            return false;
          dirty.current = false;
          setLoaded((current) => ({
            draft,
            notes,
            key: (current?.key ?? 0) + 1,
          }));
          toast.success("Proposal loaded. Review it and save.");
          return true;
        }}
      />
    </div>
  );
}

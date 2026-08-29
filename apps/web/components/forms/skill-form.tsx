"use client";

import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SheetFooter } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/mutate";

type SkillFormValues = {
  id: string;
  name: string;
  description: string;
  content: string;
};

export function SkillForm({
  initial,
  onSuccess,
  onCancel,
}: {
  initial?: SkillFormValues;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const mode = initial ? "edit" : "create";

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const body = { name, description, content };
    try {
      if (mode === "create") {
        await apiRequest("/api/skills", {
          method: "POST",
          body: JSON.stringify(body),
        });
        toast.success("Skill created.");
      } else {
        await apiRequest(`/api/skills/${initial?.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        toast.success("Skill updated.");
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-1 flex-col overflow-hidden"
    >
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
          />
          <p className="text-xs text-muted-foreground">
            Always injected into the agent's system prompt. The full content is
            loaded on demand with the `load_skill` tool.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="content">Content</Label>
          <Textarea
            id="content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={10}
            required
          />
        </div>
      </div>
      <SheetFooter className="flex-row items-center justify-end gap-2 border-t">
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving..." : mode === "create" ? "Create" : "Save"}
        </Button>
      </SheetFooter>
    </form>
  );
}

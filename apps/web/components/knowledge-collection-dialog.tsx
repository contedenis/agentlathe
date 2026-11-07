"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactElement, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/mutate";

type Collection = { id: string; name: string; description: string };

export function KnowledgeCollectionDialog({
  initial,
  trigger,
}: {
  initial?: Collection;
  trigger: ReactElement;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");

  function changeOpen(next: boolean) {
    if (next) {
      setName(initial?.name ?? "");
      setDescription(initial?.description ?? "");
      setError(null);
    }
    setOpen(next);
  }
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const body = JSON.stringify({ name, description });
      if (initial) {
        await apiRequest(`/api/knowledge/collections/${initial.id}`, {
          method: "PATCH",
          body,
        });
        toast.success("Collection updated.");
        router.refresh();
      } else {
        const created = await apiRequest<{ id: string }>(
          "/api/knowledge/collections",
          { method: "POST", body },
        );
        toast.success("Collection created.");
        router.push(`/knowledge/${created.id}`);
      }
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {initial ? "Edit collection" : "New collection"}
            </DialogTitle>
            <DialogDescription>
              A group of documents you attach to agents.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="collection-name">Name</Label>
            <Input
              id="collection-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="collection-description">Description</Label>
            <Textarea
              id="collection-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              Agents read it in their instructions to decide when to search this
              collection, so say what is in it.
            </p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : initial ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

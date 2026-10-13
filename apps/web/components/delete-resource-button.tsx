"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
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
import { apiRequest } from "@/lib/mutate";

export function DeleteResourceButton({
  endpoint,
  resourceLabel,
  redirectTo,
  size = "default",
  description,
  subtle = false,
}: {
  endpoint: string;
  resourceLabel: string;
  redirectTo: string;
  size?: "default" | "sm";
  description?: string;
  subtle?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleDelete() {
    setPending(true);
    try {
      await apiRequest(endpoint, { method: "DELETE" });
      toast.success(`Deleted ${resourceLabel}.`);
      setOpen(false);
      router.push(redirectTo);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant={subtle ? "ghost" : "destructive"}
            size={size}
            className={
              subtle ? "text-destructive hover:text-destructive" : undefined
            }
          />
        }
      >
        Delete
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {resourceLabel}</DialogTitle>
          <DialogDescription>
            {description ??
              `This deletes the resource and all its relations (cascade). It cannot be undone. If you only want it to stop being used, use "Deactivate" instead.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={handleDelete}
          >
            {pending ? "Deleting..." : "Confirm delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

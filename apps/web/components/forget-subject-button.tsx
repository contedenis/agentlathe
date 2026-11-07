"use client";

import type { SubjectFootprint } from "@agentlathe/db";
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

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

export function ForgetSubjectButton({
  subjectId,
  footprint,
  redirectTo,
}: {
  subjectId: string;
  footprint: SubjectFootprint;
  redirectTo: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleForget() {
    setPending(true);
    try {
      await apiRequest("/api/subjects/forget", {
        method: "POST",
        body: JSON.stringify({ subjectId }),
      });
      toast.success(`Forgot ${subjectId}.`);
      setOpen(false);
      router.push(redirectTo);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not forget.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        Forget subject
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Forget <span className="font-mono">{subjectId}</span>
          </DialogTitle>
          <DialogDescription>
            This deletes everything agentlathe keeps under this subject. It
            cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {footprint.memories > 0 && (
            <li>
              Its memory in {plural(footprint.memories, "agent", "agents")},
              with its history.
            </li>
          )}
          {footprint.runs > 0 && (
            <li>
              The transcripts and fix drafts of its{" "}
              {plural(footprint.runs, "run", "runs")}. The runs stay in metrics,
              without the subject.
            </li>
          )}
          {footprint.schedules.length > 0 && (
            <li>
              {plural(
                footprint.schedules.length,
                "schedule that acts",
                "schedules that act",
              )}{" "}
              for it:{" "}
              {footprint.schedules.map((schedule) => schedule.name).join(", ")}.
            </li>
          )}
        </ul>
        <p className="text-sm text-muted-foreground">
          What its runs saved in other memories, an agent memory or one with a
          custom key, stays there.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={handleForget}
          >
            {pending ? "Forgetting..." : "Forget subject"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

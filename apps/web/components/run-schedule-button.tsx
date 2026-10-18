"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/mutate";

export function RunScheduleButton({
  scheduleId,
  size = "default",
}: {
  scheduleId: string;
  size?: "default" | "sm";
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleRun() {
    setPending(true);
    try {
      await apiRequest(`/api/schedules/${scheduleId}/run`, { method: "POST" });
      toast.success("Run started. Refresh to see how it ends.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start.");
    } finally {
      setPending(false);
      router.refresh();
    }
  }

  return (
    <Button size={size} disabled={pending} onClick={handleRun}>
      {pending ? "Starting..." : "Run now"}
    </Button>
  );
}

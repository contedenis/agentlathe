"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/mutate";

export function ToggleActiveButton({
  endpoint,
  isActive,
  size = "default",
}: {
  endpoint: string;
  isActive: boolean;
  size?: "default" | "sm";
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleToggle() {
    setPending(true);
    try {
      await apiRequest(endpoint, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !isActive }),
      });
      toast.success(isActive ? "Deactivated." : "Activated.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      variant="outline"
      size={size}
      disabled={pending}
      onClick={handleToggle}
    >
      {pending ? "Saving..." : isActive ? "Deactivate" : "Activate"}
    </Button>
  );
}

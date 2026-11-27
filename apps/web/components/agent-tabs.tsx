"use client";

import type { ReactNode } from "react";
import { Tabs } from "@/components/ui/tabs";

export function AgentTabs({
  initialTab,
  children,
}: {
  initialTab: string;
  children: ReactNode;
}) {
  return (
    <Tabs
      defaultValue={initialTab}
      onValueChange={(value) =>
        window.history.replaceState(null, "", `?tab=${value}`)
      }
    >
      {children}
    </Tabs>
  );
}

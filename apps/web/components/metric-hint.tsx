"use client";

import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function Hint({
  trigger,
  children,
  className,
}: {
  trigger: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger className={cn("cursor-help", className)}>
          {trigger}
        </TooltipTrigger>
        <TooltipContent className="max-w-64 flex-col items-start gap-1 py-2 text-left leading-relaxed">
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function MetricHint({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      <Hint
        trigger={<InfoIcon className="size-3" />}
        className="text-faint transition-colors hover:text-muted-foreground"
      >
        {children}
      </Hint>
    </span>
  );
}

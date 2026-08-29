"use client";

import type { ToolUIPart } from "@agentlathe/runner/chat-ui";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./code-block";

export function toolPreview(part: {
  state: ToolUIPart["state"];
  input?: unknown;
  output?: unknown;
  errorText?: string;
}): string | undefined {
  const value =
    part.state === "output-error"
      ? part.errorText
      : ((part.state === "output-available" ? part.output : undefined) ??
        part.input);
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function deepParseJsonStrings(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return deepParseJsonStrings(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(deepParseJsonStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, deepParseJsonStrings(v)]),
    );
  }
  return value;
}

export type ToolProps = ComponentProps<typeof Collapsible> & {
  state?: ToolUIPart["state"];
};

const ACCENT_BORDER: Partial<Record<ToolUIPart["state"], string>> = {
  "output-error": "border-l-4 border-l-destructive",
  "output-denied": "border-l-4 border-l-orange-500",
  "approval-requested": "border-l-4 border-l-amber-500",
};

export const Tool = ({ className, state, ...props }: ToolProps) => (
  <Collapsible
    className={cn(
      "not-prose mb-4 w-full rounded-lg border",
      state && ACCENT_BORDER[state],
      className,
    )}
    {...props}
  />
);

export type ToolHeaderProps = {
  title?: string;
  type: string;
  state: ToolUIPart["state"];
  preview?: string;
  className?: string;
};

export const STATUS_LABEL: Record<ToolUIPart["state"], string> = {
  "input-streaming": "Pending",
  "input-available": "Running",
  "approval-requested": "Waiting for approval",
  "approval-responded": "Responded",
  "output-available": "Completed",
  "output-error": "Error",
  "output-denied": "Denied",
};

const STATUS_ICON: Record<ToolUIPart["state"], ReactNode> = {
  "input-streaming": <CircleIcon className="size-4" />,
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "approval-requested": <ClockIcon className="size-4 text-amber-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
  "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
  "output-error": <XCircleIcon className="size-4 text-destructive" />,
  "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
};

const BADGE_VARIANT: Partial<
  Record<ToolUIPart["state"], ComponentProps<typeof Badge>["variant"]>
> = {
  "output-error": "destructive",
  "output-denied": "destructive",
};

const StatusBadge = ({ status }: { status: ToolUIPart["state"] }) => (
  <Badge
    className="gap-1.5 rounded-full text-xs"
    variant={BADGE_VARIANT[status] ?? "secondary"}
  >
    {STATUS_ICON[status]}
    {STATUS_LABEL[status]}
  </Badge>
);

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  preview,
  ...props
}: ToolHeaderProps) => (
  <CollapsibleTrigger
    className={cn("flex w-full flex-col gap-1 p-3", className)}
    {...props}
  >
    <div className="flex w-full items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-2">
        <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-sm font-medium">
          {title ?? type.split("-").slice(1).join("-")}
        </span>
        <StatusBadge status={state} />
      </div>
      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-open:rotate-180" />
    </div>
    {preview && (
      <p className="w-full truncate text-left text-xs text-muted-foreground">
        {preview}
      </p>
    )}
  </CollapsibleTrigger>
);

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn("text-popover-foreground", className)}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolUIPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden p-4", className)} {...props}>
    <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
      Parameters
    </h4>
    <CodeBlock
      code={JSON.stringify(deepParseJsonStrings(input), null, 2)}
      language="json"
    />
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolUIPart["output"];
  errorText: ToolUIPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) return null;

  let content: ReactNode = <div>{output as ReactNode}</div>;
  if (typeof output === "object" && !isValidElement(output)) {
    content = (
      <CodeBlock
        code={JSON.stringify(deepParseJsonStrings(output), null, 2)}
        language="json"
      />
    );
  } else if (typeof output === "string") {
    const parsed = deepParseJsonStrings(output);
    content = (
      <CodeBlock
        code={
          typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)
        }
        language="json"
      />
    );
  }

  return (
    <div className={cn("space-y-2 p-4", className)} {...props}>
      <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {errorText ? "Error" : "Result"}
      </h4>
      {errorText ? (
        <p className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">
          {errorText}
        </p>
      ) : (
        content
      )}
    </div>
  );
};

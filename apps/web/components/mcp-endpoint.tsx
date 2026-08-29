"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

export function McpEndpoint({
  agents,
}: {
  agents: { id: string; name: string; slug: string }[];
}) {
  const [origin, setOrigin] = useState("");
  const [agentSlug, setAgentSlug] = useState("");
  const { copied, copy } = useCopyToClipboard();

  useEffect(() => setOrigin(window.location.origin), []);

  if (agents.length === 0) return null;

  const selected = agents.some((agent) => agent.slug === agentSlug)
    ? agentSlug
    : agents[0].slug;
  const path = `/mcp/agents/${selected}`;
  const url = origin ? `${origin}${path}` : path;

  return (
    <div className="rounded-md border bg-sidebar-accent p-3">
      <div className="flex items-center gap-1.5 font-mono text-[10px] font-medium tracking-[0.16em] text-faint uppercase">
        <span className="size-1.5 rounded-full bg-info ring-[3px] ring-info/15" />
        MCP per agent
      </div>
      <Select
        value={selected}
        onValueChange={(value) => setAgentSlug(value ?? "")}
      >
        <SelectTrigger size="sm" className="mt-2 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {agents.map((agent) => (
            <SelectItem key={agent.id} value={agent.slug}>
              {agent.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span
          title={url}
          className="truncate font-mono text-[11px] text-sidebar-foreground"
        >
          {path}
        </span>
        <button
          type="button"
          onClick={() => copy(url)}
          aria-label="Copy the agent MCP URL"
          className="ml-auto shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-primary"
        >
          {copied ? (
            <CheckIcon className="size-3.5 text-success" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

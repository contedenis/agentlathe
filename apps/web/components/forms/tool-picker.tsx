"use client";

import { ShieldCheckIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useListFilter } from "@/lib/use-list-filter";
import {
  MCP_TOOL_FILTER_THRESHOLD,
  useMcpToolDiscovery,
} from "@/lib/use-mcp-tool-discovery";

type CatalogItem = { id: string; name: string };
export type McpToolSelection = {
  serverId: string;
  toolName: string;
  needsApproval?: boolean;
};

export type ToolPickerCatalogs = {
  skills: CatalogItem[];
  tools: CatalogItem[];
  mcpServers: CatalogItem[];
  subAgentCandidates: CatalogItem[];
};

function toggleId(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

function CheckboxList({
  idPrefix,
  items,
  selectedIds,
  onChange,
  emptyLabel,
}: {
  idPrefix: string;
  items: CatalogItem[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  emptyLabel: string;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
      {items.map((item) => {
        const inputId = `${idPrefix}-${item.id}`;
        return (
          <div key={item.id} className="flex items-center gap-2">
            <Checkbox
              id={inputId}
              checked={selectedIds.includes(item.id)}
              onCheckedChange={() => onChange(toggleId(selectedIds, item.id))}
            />
            <Label htmlFor={inputId} className="font-normal">
              {item.name}
            </Label>
          </div>
        );
      })}
    </div>
  );
}

function McpServerSection({
  server,
  mcpTools,
  onMcpToolsChange,
}: {
  server: CatalogItem;
  mcpTools: McpToolSelection[];
  onMcpToolsChange: (tools: McpToolSelection[]) => void;
}) {
  const { state, discover } = useMcpToolDiscovery();
  const tools = state.status === "ready" ? state.tools : [];
  const { query, setQuery, filtered } = useListFilter(
    tools,
    (tool) => tool.name,
  );
  const selectedForServer = mcpTools.filter((t) => t.serverId === server.id);

  function isMcpToolSelected(toolName: string) {
    return mcpTools.some(
      (t) => t.serverId === server.id && t.toolName === toolName,
    );
  }

  function toggleMcpTool(toolName: string) {
    onMcpToolsChange(
      isMcpToolSelected(toolName)
        ? mcpTools.filter(
            (t) => !(t.serverId === server.id && t.toolName === toolName),
          )
        : [...mcpTools, { serverId: server.id, toolName }],
    );
  }

  function toggleMcpApproval(toolName: string) {
    onMcpToolsChange(
      mcpTools.map((t) =>
        t.serverId === server.id && t.toolName === toolName
          ? { ...t, needsApproval: !t.needsApproval }
          : t,
      ),
    );
  }

  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium">{server.name}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={state.status === "loading"}
          onClick={() => discover({ serverId: server.id })}
        >
          {state.status === "loading" ? "Loading..." : "Load tools"}
        </Button>
      </div>

      {state.status === "error" && (
        <p className="mt-2 text-destructive">{state.message}</p>
      )}

      {state.status === "ready" && (
        <div className="mt-2">
          {tools.length > MCP_TOOL_FILTER_THRESHOLD && (
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tool..."
              className="mb-2 h-7"
            />
          )}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {(() => {
              if (tools.length === 0) {
                return (
                  <p className="text-muted-foreground">
                    The server exposes no tools.
                  </p>
                );
              }
              if (filtered.length === 0) {
                return (
                  <p className="text-muted-foreground">
                    No tool matches "{query}".
                  </p>
                );
              }
              return filtered.map((tool) => {
                const inputId = `mcp-${server.id}-${tool.name}`;
                return (
                  <div key={tool.name} className="flex items-center gap-2">
                    <Checkbox
                      id={inputId}
                      checked={isMcpToolSelected(tool.name)}
                      onCheckedChange={() => toggleMcpTool(tool.name)}
                    />
                    <Label htmlFor={inputId} className="font-normal">
                      {tool.name}
                    </Label>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}

      {selectedForServer.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          <div className="flex flex-wrap gap-1">
            {selectedForServer.map((selection) => (
              <Badge
                key={selection.toolName}
                variant={selection.needsApproval ? "default" : "secondary"}
                className="gap-1"
              >
                {selection.toolName}
                <button
                  type="button"
                  aria-label={`Toggle approval for ${selection.toolName}`}
                  title={
                    selection.needsApproval
                      ? "Requires approval before running — click to disable"
                      : "Runs without approval — click to require it"
                  }
                  onClick={() => toggleMcpApproval(selection.toolName)}
                >
                  <ShieldCheckIcon aria-hidden className="size-3" />
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${selection.toolName}`}
                  onClick={() => toggleMcpTool(selection.toolName)}
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Click the shield to require approval before a tool runs. Highlighted
            tools ask first.
          </p>
        </div>
      )}
    </div>
  );
}

export function ToolPicker({
  catalogs,
  skillIds,
  onSkillIdsChange,
  toolIds,
  onToolIdsChange,
  subAgentIds,
  onSubAgentIdsChange,
  mcpTools,
  onMcpToolsChange,
}: {
  catalogs: ToolPickerCatalogs;
  skillIds: string[];
  onSkillIdsChange: (ids: string[]) => void;
  toolIds: string[];
  onToolIdsChange: (ids: string[]) => void;
  subAgentIds: string[];
  onSubAgentIdsChange: (ids: string[]) => void;
  mcpTools: McpToolSelection[];
  onMcpToolsChange: (tools: McpToolSelection[]) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Label>Skills</Label>
        <CheckboxList
          idPrefix="skill"
          items={catalogs.skills}
          selectedIds={skillIds}
          onChange={onSkillIdsChange}
          emptyLabel="No active skills."
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label>HTTP tools</Label>
        <CheckboxList
          idPrefix="tool"
          items={catalogs.tools}
          selectedIds={toolIds}
          onChange={onToolIdsChange}
          emptyLabel="No active HTTP tools."
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Sub-agents</Label>
        <CheckboxList
          idPrefix="subagent"
          items={catalogs.subAgentCandidates}
          selectedIds={subAgentIds}
          onChange={onSubAgentIdsChange}
          emptyLabel="No other active agents available as sub-agents."
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label>MCP tools</Label>
        {catalogs.mcpServers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active MCP servers.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {catalogs.mcpServers.map((server) => (
              <McpServerSection
                key={server.id}
                server={server}
                mcpTools={mcpTools}
                onMcpToolsChange={onMcpToolsChange}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

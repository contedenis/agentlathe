"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useListFilter } from "@/lib/use-list-filter";
import {
  MCP_TOOL_FILTER_THRESHOLD,
  useMcpToolDiscovery,
} from "@/lib/use-mcp-tool-discovery";

export function TestMcpServerButton({
  serverUrl,
  authConfig,
  disabled,
  serverId,
  useSavedAuth,
}: {
  serverUrl: string;
  authConfig: unknown;
  disabled?: boolean;
  serverId?: string;
  useSavedAuth?: boolean;
}) {
  const { state, discover } = useMcpToolDiscovery();
  const tools = state.status === "ready" ? state.tools : [];
  const {
    query: filter,
    setQuery: setFilter,
    filtered,
  } = useListFilter(tools, (tool) => tool.name);

  async function handleTest() {
    setFilter("");
    await discover(
      serverId && useSavedAuth
        ? { serverId, serverUrl }
        : { serverUrl, authConfig },
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        disabled={disabled || state.status === "loading" || !serverUrl}
        onClick={handleTest}
      >
        {state.status === "loading"
          ? "Testing..."
          : serverId && useSavedAuth
            ? "Test with saved credentials"
            : "Test connection"}
      </Button>
      {state.status === "error" && (
        <p className="text-sm text-destructive">{state.message}</p>
      )}
      {state.status === "ready" && (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm text-muted-foreground">
            {tools.length === 0
              ? "The server exposes no tools."
              : `${tools.length} tool${tools.length === 1 ? "" : "s"} found.`}
          </p>
          {tools.length > MCP_TOOL_FILTER_THRESHOLD && (
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search tool..."
              className="h-7"
            />
          )}
          {tools.length > 0 && (
            <div className="max-h-48 overflow-y-auto rounded-lg border">
              {filtered.length === 0 ? (
                <p className="p-2 text-sm text-muted-foreground">
                  No tool matches "{filter}".
                </p>
              ) : (
                filtered.map((tool) => (
                  <div
                    key={tool.name}
                    className="border-b p-2 last:border-b-0"
                    title={tool.description}
                  >
                    <p className="font-mono text-xs">{tool.name}</p>
                    {tool.description && (
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {tool.description}
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

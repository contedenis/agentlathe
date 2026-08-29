"use client";

import { useState } from "react";
import { apiRequest } from "@/lib/mutate";

export const MCP_TOOL_FILTER_THRESHOLD = 6;

export type DiscoveredTool = { name: string; description?: string };

export type McpToolDiscoveryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; tools: DiscoveredTool[] };

export type McpToolDiscoverySource =
  | { serverId: string; serverUrl?: string }
  | { serverUrl: string; authConfig: unknown };

export function useMcpToolDiscovery() {
  const [state, setState] = useState<McpToolDiscoveryState>({
    status: "idle",
  });

  async function discover(source: McpToolDiscoverySource) {
    setState({ status: "loading" });
    try {
      const data =
        "authConfig" in source
          ? await apiRequest<{ tools: DiscoveredTool[] }>(
              "/api/mcp-servers/test",
              {
                method: "POST",
                body: JSON.stringify({
                  serverUrl: source.serverUrl,
                  authConfig: source.authConfig,
                }),
              },
            )
          : await apiRequest<{ tools: DiscoveredTool[] }>(
              `/api/mcp-servers/${source.serverId}/tools`,
              {
                method: "POST",
                body: source.serverUrl
                  ? JSON.stringify({ serverUrl: source.serverUrl })
                  : undefined,
              },
            );
      setState({ status: "ready", tools: data.tools });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Unknown error.",
      });
    }
  }

  return { state, discover };
}

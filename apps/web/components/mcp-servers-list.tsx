"use client";

import { McpServerForm } from "@/components/forms/mcp-server-form";
import { ResourceList } from "@/components/resource-list";
import type { listMcpServers } from "@/lib/queries";

type ServerRow = Awaited<ReturnType<typeof listMcpServers>>[number];

export function McpServersList({ servers }: { servers: ServerRow[] }) {
  return (
    <ResourceList
      eyebrow="Workshop · MCP servers"
      title="MCP Servers"
      description="An MCP server exposes external tools by name, selectable per agent."
      items={servers}
      columns={[
        {
          header: "Server URL",
          cell: (server) => server.serverUrl,
          className: "max-w-xs truncate text-muted-foreground",
        },
      ]}
      searchPlaceholder="Search by name…"
      emptyTitle="No MCP servers yet"
      emptyDescription="An MCP server exposes external tools by name, selected explicitly per agent."
      createLabel="New server"
      emptyActionLabel="Create server"
      sheetTitleCreate="New MCP server"
      sheetTitleEdit="Edit MCP server"
      endpointBase={(id) => `/api/mcp-servers/${id}`}
      resourceLabel="the MCP server"
      redirectTo="/mcp-servers"
      FormComponent={McpServerForm}
    />
  );
}

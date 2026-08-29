"use client";

import { ToolForm } from "@/components/forms/tool-form";
import { ResourceList } from "@/components/resource-list";
import type { listTools } from "@/lib/queries";

type ToolRow = Awaited<ReturnType<typeof listTools>>[number];

export function ToolsList({ tools }: { tools: ToolRow[] }) {
  return (
    <ResourceList
      eyebrow="Workshop · tools"
      title="Tools"
      description="HTTP tools give an agent the ability to call an external endpoint."
      items={tools}
      columns={[
        {
          header: "Endpoint",
          cell: (tool) => tool.endpoint,
          className: "max-w-xs truncate text-muted-foreground",
        },
        {
          header: "Approval",
          cell: (tool) => (tool.needsApproval ? "Yes" : "No"),
        },
      ]}
      searchPlaceholder="Search by name…"
      emptyTitle="No tools yet"
      emptyDescription="HTTP tools give an agent the ability to call an external endpoint."
      createLabel="New tool"
      emptyActionLabel="Create tool"
      sheetTitleCreate="New tool"
      sheetTitleEdit="Edit tool"
      endpointBase={(id) => `/api/tools/${id}`}
      resourceLabel="the tool"
      redirectTo="/tools"
      FormComponent={ToolForm}
    />
  );
}

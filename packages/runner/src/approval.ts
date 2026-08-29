import type { ToolApprovalConfiguration, ToolSet } from "ai";

type RuntimeContext = Record<string, unknown>;

export type ApprovalStrategy = (
  approvalToolNames: Set<string>,
) => ToolApprovalConfiguration<ToolSet, RuntimeContext>;

export const buildDashboardToolApproval: ApprovalStrategy =
  (approvalToolNames) =>
  ({ toolCall }: { toolCall: { toolName: string } }) =>
    approvalToolNames.has(toolCall.toolName)
      ? "user-approval"
      : "not-applicable";

export const buildHeadlessToolApproval: ApprovalStrategy =
  (approvalToolNames) =>
  ({ toolCall }: { toolCall: { toolName: string } }) =>
    approvalToolNames.has(toolCall.toolName)
      ? {
          type: "denied",
          reason: `tool '${toolCall.toolName}' requires approval; not available over the API`,
        }
      : "not-applicable";

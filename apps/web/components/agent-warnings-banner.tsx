import { TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

type Warning = {
  type: "skill" | "tool" | "mcp_server" | "sub_agent";
  id: string;
  name: string;
};

const TYPE_LABEL: Record<Warning["type"], string> = {
  skill: "skill",
  tool: "tool",
  mcp_server: "MCP server",
  sub_agent: "sub-agent",
};

export function AgentWarningsBanner({ warnings }: { warnings: Warning[] }) {
  if (warnings.length === 0) return null;

  return (
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>This agent references inactive resources</AlertTitle>
      <AlertDescription>
        <ul className="list-inside list-disc">
          {warnings.map((warning) => (
            <li key={`${warning.type}-${warning.id}`}>
              {TYPE_LABEL[warning.type]} "{warning.name}" is disabled.
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

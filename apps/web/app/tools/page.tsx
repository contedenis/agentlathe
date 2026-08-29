import { ToolsList } from "@/components/tools-list";
import { listTools } from "@/lib/queries";

export default async function ToolsPage() {
  const tools = await listTools();
  return <ToolsList tools={tools} />;
}

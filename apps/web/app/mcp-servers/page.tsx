import { McpServersList } from "@/components/mcp-servers-list";
import { listMcpServers } from "@/lib/queries";

export default async function McpServersPage() {
  const servers = await listMcpServers();
  return <McpServersList servers={servers} />;
}

import { listMemoryStores } from "@/lib/queries-memory";

export async function GET() {
  return Response.json(await listMemoryStores());
}

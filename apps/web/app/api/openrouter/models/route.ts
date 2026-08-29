import { getOpenRouterModels } from "@/lib/openrouter-models";

export async function GET() {
  return Response.json({ models: await getOpenRouterModels() });
}

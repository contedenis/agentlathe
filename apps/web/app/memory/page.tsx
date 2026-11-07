import { MemoryStoresList } from "@/components/memory-stores-list";
import { listMemoryStores } from "@/lib/queries-memory";

export default async function MemoryPage() {
  return <MemoryStoresList stores={await listMemoryStores()} />;
}

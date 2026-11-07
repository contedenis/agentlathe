import { KnowledgeCollectionsList } from "@/components/knowledge-collections-list";
import { listCollections } from "@/lib/queries-knowledge";

export default async function KnowledgePage() {
  return <KnowledgeCollectionsList collections={await listCollections()} />;
}

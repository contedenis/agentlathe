import Link from "next/link";
import { notFound } from "next/navigation";
import { BreadcrumbTitle } from "@/components/breadcrumb-title";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { KnowledgeCollectionDialog } from "@/components/knowledge-collection-dialog";
import {
  KnowledgeDocumentsTable,
  KnowledgeProcessingNotice,
  UploadDocumentsButton,
} from "@/components/knowledge-documents";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatBytes } from "@/lib/format";
import { KNOWLEDGE_MODE_LABEL } from "@/lib/knowledge-modes";
import { getCollection } from "@/lib/queries-knowledge";
import { getSchedulerStatus } from "@/lib/queries-schedules";

export default async function KnowledgeCollectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [collection, scheduler] = await Promise.all([
    getCollection(id),
    getSchedulerStatus(),
  ]);
  if (!collection) notFound();
  const size = collection.documents.reduce((sum, doc) => sum + doc.size, 0);

  return (
    <div className="flex flex-col gap-4">
      <BreadcrumbTitle name={collection.name} />
      <PageHeader
        eyebrow="Knowledge · collection"
        title={collection.name}
        description={`${collection.documents.length} ${collection.documents.length === 1 ? "document" : "documents"} · ${formatBytes(size)}`}
      />

      <div className="flex flex-wrap gap-2">
        <UploadDocumentsButton collectionId={collection.id} />
        <KnowledgeCollectionDialog
          initial={{
            id: collection.id,
            name: collection.name,
            description: collection.description,
          }}
          trigger={<Button variant="outline">Edit</Button>}
        />
        <DeleteResourceButton
          endpoint={`/api/knowledge/collections/${collection.id}`}
          resourceLabel="the collection"
          redirectTo="/knowledge"
          description="Its documents, their text and their passages are deleted, and agents that use it lose access from their next run."
        />
      </div>

      <Card>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Description</dt>
            <dd className="whitespace-pre-wrap">
              {collection.description || (
                <span className="text-muted-foreground">
                  None. Agents see only the name when deciding to search it.
                </span>
              )}
            </dd>
            <dt className="text-muted-foreground">Agents</dt>
            <dd>
              {collection.agents.length === 0 ? (
                <span className="text-muted-foreground">
                  None yet. Attach it in an agent&apos;s configuration.
                </span>
              ) : (
                <ul className="flex flex-col gap-1">
                  {collection.agents.map((agent) => (
                    <li key={agent.id}>
                      <Link
                        href={`/agents/${agent.id}`}
                        className="hover:underline"
                      >
                        {agent.name}
                      </Link>{" "}
                      <span className="text-muted-foreground">
                        · {KNOWLEDGE_MODE_LABEL[agent.mode]}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
            <dt className="text-muted-foreground">Embedding model</dt>
            <dd className="font-mono text-xs">{collection.embeddingModel}</dd>
          </dl>
        </CardContent>
      </Card>

      <KnowledgeProcessingNotice
        documents={collection.documents}
        embeddingModel={collection.embeddingModel}
        schedulerSecondsAgo={scheduler.secondsAgo}
      />
      <h2 className="text-sm font-medium">Documents</h2>
      <KnowledgeDocumentsTable
        collectionId={collection.id}
        documents={collection.documents}
      />
    </div>
  );
}

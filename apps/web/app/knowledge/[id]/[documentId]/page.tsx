import { PAGE_BREAK } from "@agentlathe/db/constants";
import { notFound } from "next/navigation";
import { BreadcrumbTitle } from "@/components/breadcrumb-title";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fmt, formatBytes } from "@/lib/format";
import {
  DOCUMENT_STATUS_LABEL,
  documentStatusVariant,
} from "@/lib/knowledge-modes";
import {
  DOCUMENT_PREVIEW_CHARS,
  getKnowledgeDocument,
} from "@/lib/queries-knowledge";

export default async function KnowledgeDocumentPage({
  params,
}: {
  params: Promise<{ id: string; documentId: string }>;
}) {
  const { id, documentId } = await params;
  const doc = await getKnowledgeDocument(documentId);
  if (!doc || doc.collectionId !== id) notFound();
  const pages = (
    doc.text === null
      ? []
      : doc.mediaType === "application/pdf"
        ? doc.text.split(PAGE_BREAK)
        : [doc.text]
  ).map((text, index) => ({ number: index + 1, text }));

  return (
    <div className="flex flex-col gap-4">
      <BreadcrumbTitle name={doc.filename} parent={doc.collectionName} />
      <PageHeader
        eyebrow={`Knowledge · ${doc.collectionName}`}
        title={doc.filename}
        description={[
          formatBytes(doc.size),
          doc.pages !== null &&
            `${doc.pages} ${doc.pages === 1 ? "page" : "pages"}`,
          doc.chars !== null && `${fmt(doc.chars)} characters`,
        ]
          .filter(Boolean)
          .join(" · ")}
        action={
          <Badge variant={documentStatusVariant(doc.status)}>
            {DOCUMENT_STATUS_LABEL[doc.status]}
          </Badge>
        }
      />
      <div className="flex flex-wrap gap-2">
        <a
          href={`/api/knowledge/documents/${doc.id}/file`}
          download
          className={buttonVariants({ variant: "outline" })}
        >
          Download original
        </a>
        <DeleteResourceButton
          endpoint={`/api/knowledge/documents/${doc.id}`}
          resourceLabel={doc.filename}
          redirectTo={`/knowledge/${doc.collectionId}`}
          description="The document, its extracted text and its passages are deleted. Agents stop finding it from their next run."
        />
      </div>
      {doc.error && (
        <p className="text-sm text-destructive">
          {doc.status === "failed" ? doc.error : `Retrying after: ${doc.error}`}
        </p>
      )}
      <h2 className="text-sm font-medium">Extracted text</h2>
      <p className="text-sm text-muted-foreground">
        What agents search and read. If something is missing or garbled here, it
        is missing for the agent too.
        {doc.chars !== null &&
          doc.chars > DOCUMENT_PREVIEW_CHARS &&
          ` Showing the first ${fmt(DOCUMENT_PREVIEW_CHARS)} of ${fmt(doc.chars)} characters.`}
      </p>
      {pages.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {doc.status === "failed"
            ? "No text could be extracted from this file, so agents cannot use it. Upload a version with a text layer."
            : "Not extracted yet."}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {pages.map((page) => (
            <Card key={page.number}>
              <CardContent className="flex flex-col gap-2">
                {pages.length > 1 && (
                  <span className="font-mono text-xs text-muted-foreground">
                    Page {page.number}
                  </span>
                )}
                <pre className="font-sans text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {page.text.trim() || "(no text on this page)"}
                </pre>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

"use client";

import {
  MAX_DOCUMENT_BYTES,
  PROCESSING_ATTEMPTS,
} from "@agentlathe/db/constants";
import { TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { EmptyState } from "@/components/empty-state";
import { LIST_TABLE_CLASS } from "@/components/list-search";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes } from "@/lib/format";
import {
  DOCUMENT_STATUS_LABEL,
  documentStatusVariant,
} from "@/lib/knowledge-modes";
import { apiRequest } from "@/lib/mutate";
import type { CollectionDetail } from "@/lib/queries-knowledge";
import { schedulerRunning } from "@/lib/scheduler-status";

const POLL_MS = 3000;
const ACCEPT = ".pdf,.md,.markdown,.txt";

type Document = CollectionDetail["documents"][number];

function StatusBadge({ document }: { document: Document }) {
  return (
    <Badge variant={documentStatusVariant(document.status)}>
      {DOCUMENT_STATUS_LABEL[document.status]}
    </Badge>
  );
}

export function UploadDocumentsButton({
  collectionId,
}: {
  collectionId: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    let uploaded = 0;
    for (const file of files) {
      if (file.size > MAX_DOCUMENT_BYTES) {
        toast.error(
          `${file.name}: files can be at most ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`,
        );
        continue;
      }
      setUploading(file.name);
      const body = new FormData();
      body.set("file", file);
      const res = await fetch(
        `/api/knowledge/collections/${collectionId}/documents`,
        { method: "POST", body },
      ).catch(() => null);
      if (res?.ok) {
        uploaded += 1;
        router.refresh();
      } else {
        const error = await res
          ?.json()
          .then((json: { error?: string }) => json.error)
          .catch(() => undefined);
        toast.error(`${file.name}: ${error ?? "the upload failed."}`);
      }
    }
    setUploading(null);
    if (uploaded > 0)
      toast.success(
        uploaded === 1
          ? "Document uploaded."
          : `${uploaded} documents uploaded.`,
      );
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={upload}
        data-testid="knowledge-upload"
      />
      <Button
        disabled={uploading !== null}
        onClick={() => input.current?.click()}
      >
        {uploading ? `Uploading ${uploading}…` : "Upload documents"}
      </Button>
    </>
  );
}

function RetryButton({ documentId }: { documentId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function retry() {
    setPending(true);
    try {
      await apiRequest(`/api/knowledge/documents/${documentId}/retry`, {
        method: "POST",
      });
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not retry.");
    } finally {
      setPending(false);
    }
  }
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={retry}>
      Retry
    </Button>
  );
}

export function KnowledgeDocumentsTable({
  collectionId,
  documents,
}: {
  collectionId: string;
  documents: Document[];
}) {
  const router = useRouter();
  const waiting = documents.some(
    (doc) => doc.status === "pending" || doc.status === "processing",
  );
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, router]);

  if (documents.length === 0)
    return (
      <EmptyState
        title="No documents yet"
        description="Upload PDF files with a text layer, Markdown or plain text, up to 20 MB each. They are processed in the background."
      />
    );

  return (
    <Table containerClassName={LIST_TABLE_CLASS}>
      <TableHeader>
        <TableRow>
          <TableHead>Document</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Pages</TableHead>
          <TableHead>Size</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {documents.map((doc) => (
          <TableRow key={doc.id}>
            <TableCell className="max-w-xs">
              <Link
                href={`/knowledge/${collectionId}/${doc.id}`}
                className="block truncate font-medium hover:underline"
              >
                {doc.filename}
              </Link>
              {doc.error && (
                <span className="block text-xs text-destructive">
                  {doc.status === "failed"
                    ? doc.error
                    : `Retrying after: ${doc.error}`}
                </span>
              )}
            </TableCell>
            <TableCell>
              <StatusBadge document={doc} />
            </TableCell>
            <TableCell className="font-mono text-xs tabular-nums">
              {doc.pages ?? "—"}
            </TableCell>
            <TableCell className="font-mono text-xs tabular-nums">
              {formatBytes(doc.size)}
            </TableCell>
            <TableCell>
              <div className="flex justify-end gap-2">
                {doc.status === "failed" &&
                  doc.attempts >= PROCESSING_ATTEMPTS && (
                    <RetryButton documentId={doc.id} />
                  )}
                <DeleteResourceButton
                  endpoint={`/api/knowledge/documents/${doc.id}`}
                  resourceLabel={doc.filename}
                  redirectTo={`/knowledge/${collectionId}`}
                  description="The document, its extracted text and its passages are deleted. Agents stop finding it from their next run."
                  size="sm"
                  subtle
                />
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function KnowledgeProcessingNotice({
  documents,
  embeddingModel,
  schedulerSecondsAgo,
}: {
  documents: Document[];
  embeddingModel: string;
  schedulerSecondsAgo: number | null;
}) {
  const waiting = documents.filter(
    (doc) => doc.status === "pending" || doc.status === "processing",
  );
  const reindexing = documents.filter(
    (doc) =>
      doc.embeddingModel !== null && doc.embeddingModel !== embeddingModel,
  );
  const schedulerDown = !schedulerRunning(schedulerSecondsAgo);
  return (
    <>
      {waiting.length > 0 && schedulerDown && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>No scheduler is running</AlertTitle>
          <AlertDescription>
            Documents are processed right after they are uploaded. A document
            whose processing was interrupted, or that waits to be retried, is
            picked up again only while the app runs with the scheduler on (
            <span className="font-mono">SCHEDULER_ENABLED</span> unset or true).
          </AlertDescription>
        </Alert>
      )}
      {reindexing.length > 0 && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Re-indexing with {embeddingModel}</AlertTitle>
          <AlertDescription>
            {reindexing.length === 1
              ? "1 document was indexed"
              : `${reindexing.length} documents were indexed`}{" "}
            with another embedding model. Until it is indexed again, search does
            not find it; agents that read the collection whole are not affected.
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}
